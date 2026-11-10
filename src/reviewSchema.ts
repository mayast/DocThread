import { v2SidecarPath } from './source.ts';
import type {
  Anchor,
  AnchorConfidence,
  Comment,
  DocThreadFile,
  DocThreadFileMeta,
  DocThreadFileV1,
  DocThreadFileV2,
  MentionReference,
  NotificationDispatch,
  NotificationDispatchState,
  NotificationRoute,
  PersistedRepositoryIdentity,
  Reaction,
  Thread,
  ThreadClocks,
  ThreadIntent,
} from './types.ts';
import type { IdentityAuthority } from './identity.ts';
import { isReactionEmoji } from './reactions.ts';

type JsonObject = Record<string, unknown>;

export interface DecodeDocThreadFileOptions {
  /** Remote repository sidecars cannot contain anonymous/local-only comments. */
  remote?: boolean;
  /** Authenticated repository target that the v2 sidecar must identify exactly. */
  expectedSource?: PersistedRepositoryIdentity;
}

export class ReviewSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ReviewSchemaError';
    this.path = path;
  }
}

function invalid(path: string, message: string): never {
  throw new ReviewSchemaError(path, message);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'expected an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, 'expected a plain object');
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) invalid(`${path}.${unknown}`, 'unknown field');
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    return invalid(path, allowEmpty ? 'expected a string' : 'expected a non-empty string');
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : stringAt(value, path);
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'expected a boolean');
  return value;
}

function integerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalid(path, `expected a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  if (!ISO_UTC_RE.test(timestamp)) invalid(path, 'expected an ISO 8601 UTC timestamp');
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) invalid(path, 'invalid timestamp');
  return new Date(milliseconds).toISOString();
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  return value;
}

const IDENTITY_KEY_RE = /^(?:github:[^:@\s]+|entra:[^:@\s]+:[^:@\s]+|azure-devops:[^:@\s]+:[^:@\s]+)$/;

function identityKeyAt(value: unknown, path: string): string {
  const key = stringAt(value, path);
  if (!IDENTITY_KEY_RE.test(key)) invalid(path, 'invalid provider identity key');
  return key;
}

function keySetAt(value: unknown, path: string, allowEmpty: boolean): string[] {
  const keys = arrayAt(value, path).map((key, index) => identityKeyAt(key, `${path}[${index}]`));
  if (!allowEmpty && keys.length === 0) invalid(path, 'expected at least one identity key');
  if (new Set(keys).size !== keys.length) invalid(path, 'duplicate identity key');
  return [...keys].sort();
}

function opaqueIdAt(value: unknown, path: string): string {
  const identifier = stringAt(value, path);
  if (/[@\s]/.test(identifier)) invalid(path, 'invalid opaque provider identifier');
  return identifier;
}

function routeAt(value: unknown, path: string): NotificationRoute {
  const route = objectAt(value, path);
  if (route.kind === 'none') {
    exactKeys(route, ['kind'], path);
    return { kind: 'none' };
  }
  if (route.kind === 'github') {
    exactKeys(route, ['kind', 'nodeId'], path);
    return { kind: 'github', nodeId: opaqueIdAt(route.nodeId, `${path}.nodeId`) };
  }
  if (route.kind === 'ado-work-item') {
    exactKeys(
      route,
      ['kind', 'organization', 'identityId', 'descriptor', 'originId'],
      path
    );
    return {
      kind: 'ado-work-item',
      organization: stringAt(route.organization, `${path}.organization`),
      identityId: opaqueIdAt(route.identityId, `${path}.identityId`),
      descriptor: opaqueIdAt(route.descriptor, `${path}.descriptor`),
      originId: opaqueIdAt(route.originId, `${path}.originId`),
    };
  }
  return invalid(`${path}.kind`, 'unknown notification route');
}

function authorityAt(value: unknown, path: string): IdentityAuthority {
  if (value === 'github' || value === 'entra' || value === 'azure-devops') return value;
  return invalid(path, 'unknown identity authority');
}

function identityKeyMatchesAuthority(key: string, authority: IdentityAuthority): boolean {
  return key.startsWith(`${authority}:`);
}

function mentionAt(value: unknown, body: string, path: string): MentionReference {
  const mention = objectAt(value, path);
  const start = integerAt(mention.start, `${path}.start`);
  const length = integerAt(mention.length, `${path}.length`, 1);
  const text = stringAt(mention.text, `${path}.text`);
  if (!text.startsWith('@')) invalid(`${path}.text`, 'mention text must include the leading @');
  if (length !== text.length) invalid(`${path}.length`, 'must equal the UTF-16 text length');
  if (start + length > body.length || body.slice(start, start + length) !== text) {
    invalid(path, 'mention span does not exactly match the immutable comment body');
  }

  if (mention.kind === 'unresolved') {
    exactKeys(mention, ['kind', 'start', 'length', 'text', 'handle'], path);
    return {
      kind: 'unresolved',
      start,
      length,
      text,
      handle: stringAt(mention.handle, `${path}.handle`),
    };
  }

  if (mention.kind === 'resolved') {
    exactKeys(
      mention,
      [
        'kind',
        'start',
        'length',
        'text',
        'subjectKey',
        'identityKeys',
        'authority',
        'displayName',
        'handle',
        'route',
      ],
      path
    );
    const subjectKey = identityKeyAt(mention.subjectKey, `${path}.subjectKey`);
    const identityKeys = keySetAt(mention.identityKeys, `${path}.identityKeys`, false);
    const authority = authorityAt(mention.authority, `${path}.authority`);
    if (!identityKeys.includes(subjectKey)) {
      invalid(`${path}.identityKeys`, 'must contain the selected subject key');
    }
    if (!identityKeyMatchesAuthority(subjectKey, authority)) {
      invalid(`${path}.authority`, 'does not match the subject key authority');
    }
    return {
      kind: 'resolved',
      start,
      length,
      text,
      subjectKey,
      identityKeys,
      authority,
      displayName: stringAt(mention.displayName, `${path}.displayName`),
      handle: opaqueIdAt(mention.handle, `${path}.handle`),
      route: routeAt(mention.route, `${path}.route`),
    };
  }

  return invalid(`${path}.kind`, 'unknown mention kind');
}

function mentionsAt(value: unknown, body: string, path: string): MentionReference[] {
  const mentions = arrayAt(value, path).map((mention, index) =>
    mentionAt(mention, body, `${path}[${index}]`)
  );
  mentions.sort((left, right) => left.start - right.start || left.length - right.length);
  for (let index = 1; index < mentions.length; index += 1) {
    const previous = mentions[index - 1];
    if (previous.start + previous.length > mentions[index].start) {
      invalid(path, 'mention spans cannot overlap');
    }
  }
  return mentions;
}

const DISPATCH_STATES: readonly NotificationDispatchState[] = [
  'pending',
  'attempted',
  'delivered',
  'failed',
  'uncertain',
];

function dispatchStateAt(value: unknown, path: string): NotificationDispatchState {
  if (typeof value === 'string' && DISPATCH_STATES.includes(value as NotificationDispatchState)) {
    return value as NotificationDispatchState;
  }
  return invalid(path, 'unknown notification dispatch state');
}

function httpsUrlAt(value: unknown, path: string): string {
  const raw = stringAt(value, path);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') invalid(path, 'provider URL must use HTTPS');
  } catch (error) {
    if (error instanceof ReviewSchemaError) throw error;
    invalid(path, 'invalid provider URL');
  }
  return raw;
}

function dispatchAt(
  value: unknown,
  mentions: readonly MentionReference[],
  path: string
): NotificationDispatch {
  const dispatch = objectAt(value, path);
  exactKeys(
    dispatch,
    [
      'channel',
      'state',
      'recipientKeys',
      'attemptId',
      'attemptedAt',
      'providerUrl',
      'errorCode',
    ],
    path
  );
  if (dispatch.channel !== 'github' && dispatch.channel !== 'ado-work-item') {
    invalid(`${path}.channel`, 'unknown dispatch channel');
  }
  const channel = dispatch.channel;
  const state = dispatchStateAt(dispatch.state, `${path}.state`);
  const recipientKeys = keySetAt(dispatch.recipientKeys, `${path}.recipientKeys`, false);
  const eligibleKeys = new Set(
    mentions
      .filter(
        (mention): mention is Extract<MentionReference, { kind: 'resolved' }> =>
          mention.kind === 'resolved' && mention.route.kind === channel
      )
      .map((mention) => mention.subjectKey)
  );
  if (recipientKeys.some((key) => !eligibleKeys.has(key))) {
    invalid(`${path}.recipientKeys`, 'contains a subject without a matching resolved route');
  }

  const attemptId = optionalString(dispatch.attemptId, `${path}.attemptId`);
  const attemptedAt =
    dispatch.attemptedAt === undefined
      ? undefined
      : timestampAt(dispatch.attemptedAt, `${path}.attemptedAt`);
  if (state === 'pending' && (attemptId !== undefined || attemptedAt !== undefined)) {
    invalid(path, 'pending dispatch cannot contain attempt claim metadata');
  }
  if (state !== 'pending' && (!attemptId || !attemptedAt)) {
    invalid(path, `${state} dispatch requires attemptId and attemptedAt`);
  }

  const result: NotificationDispatch = { channel, state, recipientKeys };
  if (attemptId !== undefined) result.attemptId = attemptId;
  if (attemptedAt !== undefined) result.attemptedAt = attemptedAt;
  if (dispatch.providerUrl !== undefined) {
    result.providerUrl = httpsUrlAt(dispatch.providerUrl, `${path}.providerUrl`);
  }
  if (dispatch.errorCode !== undefined) {
    result.errorCode = stringAt(dispatch.errorCode, `${path}.errorCode`);
  }
  return result;
}

function reactionAt(value: unknown, path: string): Reaction {
  const reaction = objectAt(value, path);
  exactKeys(reaction, ['emoji', 'by', 'byName', 'at', 'removed'], path);
  const emoji = stringAt(reaction.emoji, `${path}.emoji`);
  if (!isReactionEmoji(emoji)) invalid(`${path}.emoji`, 'unsupported reaction emoji');
  const by = identityKeyAt(reaction.by, `${path}.by`);
  const at = timestampAt(reaction.at, `${path}.at`);
  const byName = optionalString(reaction.byName, `${path}.byName`);
  if (reaction.removed !== undefined && reaction.removed !== true) {
    invalid(`${path}.removed`, 'must be true when present');
  }
  return {
    emoji,
    by,
    at,
    ...(byName !== undefined ? { byName } : {}),
    ...(reaction.removed === true ? { removed: true as const } : {}),
  };
}

function reactionsAt(value: unknown, path: string): Reaction[] {
  const reactions = arrayAt(value, path).map((entry, index) =>
    reactionAt(entry, `${path}[${index}]`)
  );
  const seen = new Set<string>();
  for (const reaction of reactions) {
    const key = `${reaction.emoji}\u0000${reaction.by}`;
    if (seen.has(key)) {
      invalid(path, 'duplicate reaction for the same reactor and emoji');
    }
    seen.add(key);
  }
  return reactions;
}

function commentAt(value: unknown, path: string, remote: boolean): Comment {
  const comment = objectAt(value, path);
  exactKeys(
    comment,
    [
      'id',
      'author',
      'authorLogin',
      'authorIdentityKeys',
      'identityVersion',
      'localOnly',
      'mentions',
      'body',
      'createdAt',
      'dispatch',
      'reactions',
    ],
    path
  );
  const id = stringAt(comment.id, `${path}.id`);
  const author = stringAt(comment.author, `${path}.author`);
  const body = stringAt(comment.body, `${path}.body`, true);
  const createdAt = timestampAt(comment.createdAt, `${path}.createdAt`);
  if (comment.identityVersion !== undefined && comment.identityVersion !== 1) {
    invalid(`${path}.identityVersion`, 'unknown comment identity version');
  }
  const identityVersion = comment.identityVersion === 1 ? 1 : undefined;
  if (comment.localOnly !== undefined && comment.localOnly !== true) {
    invalid(`${path}.localOnly`, 'must be true when present');
  }
  const localOnly = comment.localOnly === true;
  if (remote && localOnly) invalid(`${path}.localOnly`, 'not allowed in a remote sidecar');

  const authorLogin = optionalString(comment.authorLogin, `${path}.authorLogin`);
  const authorIdentityKeys =
    comment.authorIdentityKeys === undefined
      ? undefined
      : keySetAt(comment.authorIdentityKeys, `${path}.authorIdentityKeys`, localOnly);
  const mentions =
    comment.mentions === undefined
      ? undefined
      : mentionsAt(comment.mentions, body, `${path}.mentions`);

  if (identityVersion === 1) {
    if (!authorIdentityKeys || !mentions) {
      invalid(path, 'identity-aware comments require authorIdentityKeys and mentions arrays');
    }
    if (!localOnly && authorIdentityKeys.length === 0) {
      invalid(`${path}.authorIdentityKeys`, 'remote-capable comments require an author identity');
    }
    if (localOnly && mentions.some((mention) => mention.kind === 'resolved')) {
      invalid(`${path}.mentions`, 'local-only comments can contain only unresolved mentions');
    }
  } else if (authorIdentityKeys !== undefined || mentions?.some((mention) => mention.kind === 'resolved')) {
    invalid(path, 'stable identity metadata requires identityVersion 1');
  }

  let dispatch: NotificationDispatch | undefined;
  if (comment.dispatch !== undefined) {
    if (identityVersion !== 1 || !mentions) {
      invalid(`${path}.dispatch`, 'dispatch requires an identity-aware comment');
    }
    dispatch = dispatchAt(comment.dispatch, mentions, `${path}.dispatch`);
  }
  const reactions =
    comment.reactions === undefined
      ? undefined
      : reactionsAt(comment.reactions, `${path}.reactions`);
  return {
    id,
    author,
    body,
    createdAt,
    ...(authorLogin !== undefined ? { authorLogin } : {}),
    ...(authorIdentityKeys !== undefined ? { authorIdentityKeys } : {}),
    ...(identityVersion !== undefined ? { identityVersion } : {}),
    ...(localOnly ? { localOnly: true as const } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
    ...(dispatch !== undefined ? { dispatch } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
  };
}

function anchorAt(value: unknown, path: string): Anchor {
  const anchor = objectAt(value, path);
  exactKeys(anchor, ['quote', 'prefix', 'suffix', 'start'], path);
  return {
    quote: stringAt(anchor.quote, `${path}.quote`, true),
    prefix: stringAt(anchor.prefix, `${path}.prefix`, true),
    suffix: stringAt(anchor.suffix, `${path}.suffix`, true),
    start: integerAt(anchor.start, `${path}.start`),
  };
}

function intentAt(value: unknown, path: string): ThreadIntent {
  if (value === 'question' || value === 'suggestion' || value === 'blocking') return value;
  return invalid(path, 'unknown thread intent');
}

function confidenceAt(value: unknown, path: string): AnchorConfidence {
  if (
    value === 'exact' ||
    value === 'high' ||
    value === 'medium' ||
    value === 'needs-confirmation' ||
    value === 'orphaned'
  ) {
    return value;
  }
  return invalid(path, 'unknown anchor confidence');
}

function clocksAt(value: unknown, path: string): Partial<ThreadClocks> {
  const clocks = objectAt(value, path);
  exactKeys(clocks, ['resolutionAt', 'intentAt', 'anchorAt'], path);
  const result: Partial<ThreadClocks> = {};
  if (clocks.resolutionAt !== undefined) {
    result.resolutionAt = timestampAt(clocks.resolutionAt, `${path}.resolutionAt`);
  }
  if (clocks.intentAt !== undefined) {
    result.intentAt = timestampAt(clocks.intentAt, `${path}.intentAt`);
  }
  if (clocks.anchorAt !== undefined) {
    result.anchorAt = timestampAt(clocks.anchorAt, `${path}.anchorAt`);
  }
  return result;
}

function suggestionAt(value: unknown, path: string): Thread['suggestion'] {
  const suggestion = objectAt(value, path);
  exactKeys(suggestion, ['replacement', 'origin', 'skillName', 'appliedAt'], path);
  const replacement = stringAt(suggestion.replacement, `${path}.replacement`, true);
  let origin: 'human' | 'ai' | undefined;
  if (suggestion.origin !== undefined) {
    if (suggestion.origin !== 'human' && suggestion.origin !== 'ai') {
      invalid(`${path}.origin`, 'unknown suggestion origin');
    }
    origin = suggestion.origin;
  }
  const skillName = optionalString(suggestion.skillName, `${path}.skillName`);
  const appliedAt =
    suggestion.appliedAt === undefined
      ? undefined
      : timestampAt(suggestion.appliedAt, `${path}.appliedAt`);
  return {
    replacement,
    ...(origin ? { origin } : {}),
    ...(skillName ? { skillName } : {}),
    ...(appliedAt ? { appliedAt } : {}),
  };
}

function threadAt(value: unknown, path: string, remote: boolean): Thread {
  const thread = objectAt(value, path);
  exactKeys(
    thread,
    [
      'id',
      'anchor',
      'comments',
      'resolved',
      'createdAt',
      'intent',
      'suggestion',
      'clocks',
      'deletedAt',
      'located',
      'confidence',
    ],
    path
  );
  const id = stringAt(thread.id, `${path}.id`);
  const createdAt = timestampAt(thread.createdAt, `${path}.createdAt`);
  const comments = arrayAt(thread.comments, `${path}.comments`).map((comment, index) =>
    commentAt(comment, `${path}.comments[${index}]`, remote)
  );
  if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
    invalid(`${path}.comments`, 'duplicate comment ID');
  }
  const result: Thread = {
    id,
    anchor: anchorAt(thread.anchor, `${path}.anchor`),
    comments,
    resolved: booleanAt(thread.resolved, `${path}.resolved`),
    createdAt,
  };
  if (thread.intent !== undefined) result.intent = intentAt(thread.intent, `${path}.intent`);
  if (thread.suggestion !== undefined) {
    result.suggestion = suggestionAt(thread.suggestion, `${path}.suggestion`);
  }
  if (thread.clocks !== undefined) result.clocks = clocksAt(thread.clocks, `${path}.clocks`);
  if (thread.deletedAt !== undefined) {
    const deletedAt = timestampAt(thread.deletedAt, `${path}.deletedAt`);
    if (deletedAt < createdAt) invalid(`${path}.deletedAt`, 'cannot predate thread creation');
    result.deletedAt = deletedAt;
  }
  if (thread.located !== undefined) result.located = booleanAt(thread.located, `${path}.located`);
  if (thread.confidence !== undefined) {
    result.confidence = confidenceAt(thread.confidence, `${path}.confidence`);
  }
  return result;
}

function threadsAt(value: unknown, path: string, remote: boolean): Thread[] {
  const threads = arrayAt(value, path).map((thread, index) =>
    threadAt(thread, `${path}[${index}]`, remote)
  );
  if (new Set(threads.map((thread) => thread.id)).size !== threads.length) {
    invalid(path, 'duplicate thread ID');
  }
  const commentIds = threads.flatMap((thread) => thread.comments.map((comment) => comment.id));
  if (new Set(commentIds).size !== commentIds.length) {
    invalid(path, 'comment IDs must be unique across the file');
  }
  return threads;
}

function metaAt(value: unknown, path: string): DocThreadFileMeta {
  const meta = objectAt(value, path);
  exactKeys(meta, ['source', 'title', 'sourceUrl'], path);
  const result: DocThreadFileMeta = {};
  if (meta.source !== undefined) {
    if (
      meta.source !== 'github' &&
      meta.source !== 'azure-repos' &&
      meta.source !== 'ado-workitem' &&
      meta.source !== 'ado'
    ) {
      invalid(`${path}.source`, 'unknown legacy source');
    }
    result.source = meta.source;
  }
  if (meta.title !== undefined) result.title = stringAt(meta.title, `${path}.title`);
  if (meta.sourceUrl !== undefined) result.sourceUrl = stringAt(meta.sourceUrl, `${path}.sourceUrl`);
  return result;
}

function persistedSourceAt(value: unknown, path: string): PersistedRepositoryIdentity {
  const source = objectAt(value, path);
  exactKeys(source, ['provider', 'path'], path);
  if (source.provider !== 'github' && source.provider !== 'azure-repos') {
    invalid(`${path}.provider`, 'unknown repository provider');
  }
  const sourcePath = stringAt(source.path, `${path}.path`);
  try {
    v2SidecarPath(sourcePath);
  } catch (error) {
    invalid(`${path}.path`, error instanceof Error ? error.message : 'invalid repository path');
  }
  return { provider: source.provider, path: sourcePath };
}

function commonFields(
  file: JsonObject,
  path: string,
  remote: boolean
): Pick<DocThreadFileV1, 'docPath' | 'threads' | 'updatedAt' | 'markdown' | 'meta'> {
  const result: Pick<DocThreadFileV1, 'docPath' | 'threads' | 'updatedAt' | 'markdown' | 'meta'> = {
    docPath: stringAt(file.docPath, `${path}.docPath`),
    threads: threadsAt(file.threads, `${path}.threads`, remote),
    updatedAt: timestampAt(file.updatedAt, `${path}.updatedAt`),
  };
  if (file.markdown !== undefined) {
    result.markdown = stringAt(file.markdown, `${path}.markdown`, true);
  }
  if (file.meta !== undefined) result.meta = metaAt(file.meta, `${path}.meta`);
  return result;
}

/** Decode and clone untrusted sidecar JSON. No loader should cast parsed JSON directly. */
export function decodeDocThreadFile(
  value: unknown,
  options: DecodeDocThreadFileOptions = {}
): DocThreadFile {
  const file = objectAt(value, '$');
  if (file.schemaVersion === 1) {
    exactKeys(file, ['schemaVersion', 'docPath', 'threads', 'updatedAt', 'markdown', 'meta'], '$');
    return { schemaVersion: 1, ...commonFields(file, '$', options.remote === true) };
  }

  if (file.schemaVersion === 2) {
    exactKeys(
      file,
      [
        'schemaVersion',
        'source',
        'docPath',
        'threads',
        'updatedAt',
        'markdown',
        'meta',
        'legacyPath',
        'legacyRevision',
      ],
      '$'
    );
    const source = persistedSourceAt(file.source, '$.source');
    if (
      options.expectedSource &&
      (source.provider !== options.expectedSource.provider || source.path !== options.expectedSource.path)
    ) {
      invalid('$.source', 'does not match the authenticated requested repository target');
    }
    const legacyPath = optionalString(file.legacyPath, '$.legacyPath');
    const legacyRevision = optionalString(file.legacyRevision, '$.legacyRevision');
    if ((legacyPath === undefined) !== (legacyRevision === undefined)) {
      invalid('$', 'legacyPath and legacyRevision must be present together');
    }
    if (legacyPath?.startsWith('.docthread/v2/')) {
      invalid('$.legacyPath', 'must identify the read-only schema-v1 sidecar');
    }
    const result: DocThreadFileV2 = {
      schemaVersion: 2,
      source,
      ...commonFields(file, '$', options.remote === true),
    };
    if (legacyPath !== undefined) result.legacyPath = legacyPath;
    if (legacyRevision !== undefined) result.legacyRevision = legacyRevision;
    return result;
  }

  return invalid('$.schemaVersion', 'unknown or missing schema version');
}