import { decodeDocThreadFile } from './reviewSchema.ts';
import { mergeReactionLists } from './reactions.ts';
import type {
  Anchor,
  Comment,
  DocThreadFileV2,
  NotificationDispatch,
  NotificationDispatchState,
  Thread,
  ThreadClocks,
  ThreadIntent,
} from './types.ts';

export type ReviewMergeErrorCode =
  | 'corruption'
  | 'stale-tombstone'
  | 'local-only';

export class ReviewMergeError extends Error {
  readonly code: ReviewMergeErrorCode;

  constructor(code: ReviewMergeErrorCode, message: string) {
    super(message);
    this.name = 'ReviewMergeError';
    this.code = code;
  }
}

export interface MergeDocThreadFilesOptions {
  /** Repository publication is the default; local merges may retain localOnly comments. */
  target?: 'remote' | 'local';
}

function corruption(message: string): never {
  throw new ReviewMergeError('corruption', message);
}

function staleTombstone(message: string): never {
  throw new ReviewMergeError('stale-tombstone', message);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function immutableCommentCore(comment: Comment): unknown {
  return {
    id: comment.id,
    author: comment.author,
    authorLogin: comment.authorLogin ?? null,
    authorIdentityKeys: comment.authorIdentityKeys ?? null,
    identityVersion: comment.identityVersion ?? null,
    localOnly: comment.localOnly ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
    mentions: comment.mentions ?? null,
  };
}

function assertSameCommentCore(left: Comment, right: Comment): void {
  if (!sameValue(immutableCommentCore(left), immutableCommentCore(right))) {
    corruption(`Comment ${left.id} has conflicting immutable core data.`);
  }
}

const DISPATCH_RANK: Record<NotificationDispatchState, number> = {
  pending: 0,
  attempted: 1,
  delivered: 2,
  failed: 2,
  uncertain: 2,
};

function sameDispatchClaim(left: NotificationDispatch, right: NotificationDispatch): boolean {
  return left.attemptId === right.attemptId && left.attemptedAt === right.attemptedAt;
}

function mergeDispatch(
  left: NotificationDispatch | undefined,
  right: NotificationDispatch | undefined,
  commentId: string
): NotificationDispatch | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.channel !== right.channel || !sameValue(left.recipientKeys, right.recipientKeys)) {
    corruption(`Comment ${commentId} has conflicting dispatch recipients or channel.`);
  }
  if (left.state === right.state) {
    if (!sameValue(left, right)) {
      corruption(`Comment ${commentId} has conflicting ${left.state} dispatch metadata.`);
    }
    return right;
  }

  const leftRank = DISPATCH_RANK[left.state];
  const rightRank = DISPATCH_RANK[right.state];
  if (leftRank === 2 && rightRank === 2) {
    corruption(`Comment ${commentId} has divergent terminal dispatch states.`);
  }
  const advanced = leftRank > rightRank ? left : right;
  const earlier = advanced === left ? right : left;
  if (earlier.state === 'attempted' && !sameDispatchClaim(advanced, earlier)) {
    corruption(`Comment ${commentId} changed dispatch attempt identity.`);
  }
  return advanced;
}

function mergeComments(local: Thread, remote: Thread): Comment[] {
  const remoteById = new Map(remote.comments.map((comment) => [comment.id, comment]));
  const merged = remote.comments.map((remoteComment) => {
    const localComment = local.comments.find((comment) => comment.id === remoteComment.id);
    if (!localComment) return remoteComment;
    assertSameCommentCore(localComment, remoteComment);
    const dispatch = mergeDispatch(localComment.dispatch, remoteComment.dispatch, remoteComment.id);
    const reactions = mergeReactionLists(localComment.reactions, remoteComment.reactions);
    return {
      ...remoteComment,
      ...(dispatch === undefined ? {} : { dispatch }),
      ...(reactions === undefined ? {} : { reactions }),
    };
  });
  for (const localComment of local.comments) {
    if (!remoteById.has(localComment.id)) merged.push(localComment);
  }
  return merged;
}

/** Resolve omitted legacy clocks without mutating or rewriting the input thread. */
export function initializeLegacyThreadClocks(thread: Thread): ThreadClocks {
  return {
    resolutionAt: thread.clocks?.resolutionAt ?? thread.createdAt,
    intentAt: thread.clocks?.intentAt ?? thread.createdAt,
    anchorAt: thread.clocks?.anchorAt ?? thread.createdAt,
  };
}

type ClockField = keyof ThreadClocks;

function selectByClock<T>(
  field: ClockField,
  localValue: T,
  remoteValue: T,
  localClocks: ThreadClocks,
  remoteClocks: ThreadClocks,
  threadId: string
): 'local' | 'remote' {
  const localClock = localClocks[field];
  const remoteClock = remoteClocks[field];
  if (localClock === remoteClock) {
    if (!sameValue(localValue, remoteValue)) {
      corruption(`Thread ${threadId} has unequal ${field} values at the same clock.`);
    }
    return 'remote';
  }
  return localClock > remoteClock ? 'local' : 'remote';
}

function mergedExplicitClocks(
  local: Thread,
  remote: Thread,
  localClocks: ThreadClocks,
  remoteClocks: ThreadClocks
): Partial<ThreadClocks> | undefined {
  const clocks: Partial<ThreadClocks> = {};
  for (const field of ['resolutionAt', 'intentAt', 'anchorAt'] as const) {
    if (local.clocks?.[field] !== undefined || remote.clocks?.[field] !== undefined) {
      clocks[field] = localClocks[field] > remoteClocks[field]
        ? localClocks[field]
        : remoteClocks[field];
    }
  }
  return Object.keys(clocks).length > 0 ? clocks : undefined;
}

function effectiveIntent(thread: Thread): ThreadIntent {
  return thread.intent ?? 'question';
}

function assertNoMutationAgainstRemoteTombstone(local: Thread, remote: Thread): void {
  if (!remote.deletedAt || local.deletedAt) return;
  if (local.createdAt !== remote.createdAt) {
    corruption(`Thread ${local.id} has conflicting creation timestamps.`);
  }

  const remoteComments = new Map(remote.comments.map((comment) => [comment.id, comment]));
  for (const localComment of local.comments) {
    const remoteComment = remoteComments.get(localComment.id);
    if (!remoteComment) {
      staleTombstone(`Thread ${local.id} received a stale reply after remote deletion.`);
    }
    assertSameCommentCore(localComment, remoteComment);
    const merged = mergeDispatch(localComment.dispatch, remoteComment.dispatch, localComment.id);
    if (!sameValue(merged, remoteComment.dispatch)) {
      staleTombstone(`Thread ${local.id} received a stale dispatch mutation after remote deletion.`);
    }
    const mergedReactions = mergeReactionLists(localComment.reactions, remoteComment.reactions);
    const remoteReactions = mergeReactionLists(remoteComment.reactions, undefined);
    if (!sameValue(mergedReactions, remoteReactions)) {
      staleTombstone(`Thread ${local.id} received a stale reaction after remote deletion.`);
    }
  }

  const localClocks = initializeLegacyThreadClocks(local);
  const remoteClocks = initializeLegacyThreadClocks(remote);
  const values: Array<[ClockField, unknown, unknown]> = [
    ['resolutionAt', local.resolved, remote.resolved],
    ['intentAt', effectiveIntent(local), effectiveIntent(remote)],
    ['anchorAt', local.anchor, remote.anchor],
  ];
  for (const [field, localValue, remoteValue] of values) {
    if (localClocks[field] === remoteClocks[field] && !sameValue(localValue, remoteValue)) {
      corruption(`Thread ${local.id} has unequal ${field} values at the same clock.`);
    }
    if (localClocks[field] > remoteClocks[field]) {
      staleTombstone(`Thread ${local.id} received a stale ${field} mutation after remote deletion.`);
    }
  }
}

function mergeThread(local: Thread, remote: Thread): Thread {
  if (local.createdAt !== remote.createdAt) {
    corruption(`Thread ${local.id} has conflicting creation timestamps.`);
  }
  assertNoMutationAgainstRemoteTombstone(local, remote);

  const localClocks = initializeLegacyThreadClocks(local);
  const remoteClocks = initializeLegacyThreadClocks(remote);
  const resolutionSide = selectByClock(
    'resolutionAt',
    local.resolved,
    remote.resolved,
    localClocks,
    remoteClocks,
    local.id
  );
  const intentSide = selectByClock(
    'intentAt',
    effectiveIntent(local),
    effectiveIntent(remote),
    localClocks,
    remoteClocks,
    local.id
  );
  const anchorSide = selectByClock(
    'anchorAt',
    local.anchor,
    remote.anchor,
    localClocks,
    remoteClocks,
    local.id
  );
  const intent = intentSide === 'local' ? local.intent : remote.intent;
  const clocks = mergedExplicitClocks(local, remote, localClocks, remoteClocks);
  const deletedAt =
    local.deletedAt && remote.deletedAt
      ? local.deletedAt < remote.deletedAt
        ? local.deletedAt
        : remote.deletedAt
      : local.deletedAt ?? remote.deletedAt;
  const suggestion = mergeSuggestion(local.suggestion, remote.suggestion, local.id);

  return {
    id: remote.id,
    anchor: anchorSide === 'local' ? local.anchor : remote.anchor,
    comments: mergeComments(local, remote),
    resolved: resolutionSide === 'local' ? local.resolved : remote.resolved,
    createdAt: remote.createdAt,
    ...(intent === undefined ? {} : { intent }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(clocks === undefined ? {} : { clocks }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

/**
 * Merge a thread's suggestion (#35). The proposed replacement is immutable once
 * set (conflicting replacements are corruption); `appliedAt` is a terminal
 * transition, so once either side has applied it, the applied form wins (earliest
 * timestamp on the rare double-apply).
 */
function mergeSuggestion(
  left: Thread['suggestion'],
  right: Thread['suggestion'],
  threadId: string
): Thread['suggestion'] {
  if (!left) return right;
  if (!right) return left;
  if (left.replacement !== right.replacement) {
    corruption(`Thread ${threadId} has conflicting suggestion replacements.`);
  }
  if (left.origin && right.origin && left.origin !== right.origin) {
    corruption(`Thread ${threadId} has conflicting suggestion provenance.`);
  }
  if (left.skillName && right.skillName && left.skillName !== right.skillName) {
    corruption(`Thread ${threadId} has conflicting suggestion skill provenance.`);
  }
  const origin = left.origin ?? right.origin;
  const skillName = left.skillName ?? right.skillName;
  const appliedAt =
    left.appliedAt && right.appliedAt
      ? left.appliedAt < right.appliedAt
        ? left.appliedAt
        : right.appliedAt
      : left.appliedAt ?? right.appliedAt;
  return {
    replacement: right.replacement,
    ...(origin ? { origin } : {}),
    ...(skillName ? { skillName } : {}),
    ...(appliedAt ? { appliedAt } : {}),
  };
}

function assertNoLocalOnly(file: DocThreadFileV2): void {
  for (const thread of file.threads) {
    if (thread.comments.some((comment) => comment.localOnly)) {
      throw new ReviewMergeError(
        'local-only',
        `Thread ${thread.id} contains a local-only comment that cannot be published remotely.`
      );
    }
  }
}

function decodeV2(value: unknown, remote: boolean): DocThreadFileV2 {
  const decoded = decodeDocThreadFile(value, { remote });
  if (decoded.schemaVersion !== 2) {
    corruption('Schema-v2 merge cannot accept a schema-v1 file.');
  }
  return decoded;
}

function mergeOptionalFileField<T>(
  name: string,
  local: T | undefined,
  remote: T | undefined
): T | undefined {
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (!sameValue(local, remote)) corruption(`Conflicting ${name} metadata.`);
  return remote;
}

export function mergeReviewThreads(local: Thread[], remote: Thread[]): Thread[] {
  if (new Set(local.map(thread => thread.id)).size !== local.length || new Set(remote.map(thread => thread.id)).size !== remote.length) {
    corruption('Cannot combine review copies with duplicate thread IDs.');
  }
  const localById = new Map(local.map(thread => [thread.id, thread]));
  const merged = remote.map(remoteThread => {
    const localThread = localById.get(remoteThread.id);
    return localThread ? mergeThread(localThread, remoteThread) : remoteThread;
  });
  const remoteIds = new Set(remote.map(thread => thread.id));
  for (const localThread of local) {
    if (!remoteIds.has(localThread.id)) merged.push(localThread);
  }
  return merged;
}

/**
 * Merge local schema-v2 state into the latest remote revision.
 * The second argument is directional because a remote tombstone rejects stale local mutations.
 */
export function mergeDocThreadFiles(
  localValue: DocThreadFileV2,
  remoteValue: DocThreadFileV2,
  options: MergeDocThreadFilesOptions = {}
): DocThreadFileV2 {
  const local = decodeV2(localValue, false);
  const remote = decodeV2(remoteValue, options.target !== 'local');
  if (options.target !== 'local') assertNoLocalOnly(local);

  if (local.source.provider !== remote.source.provider || local.source.path !== remote.source.path) {
    corruption('Cannot merge sidecars for different persisted repository identities.');
  }
  if (local.docPath !== remote.docPath) corruption('Cannot merge sidecars with different docPath metadata.');

  const mergedThreads = mergeReviewThreads(local.threads, remote.threads);

  const markdown = mergeOptionalFileField('markdown', local.markdown, remote.markdown);
  const meta = mergeOptionalFileField('meta', local.meta, remote.meta);
  const legacyPath = mergeOptionalFileField('legacyPath', local.legacyPath, remote.legacyPath);
  const legacyRevision = mergeOptionalFileField(
    'legacyRevision',
    local.legacyRevision,
    remote.legacyRevision
  );
  return {
    schemaVersion: 2,
    source: remote.source,
    docPath: remote.docPath,
    threads: mergedThreads,
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
    ...(markdown === undefined ? {} : { markdown }),
    ...(meta === undefined ? {} : { meta }),
    ...(legacyPath === undefined ? {} : { legacyPath }),
    ...(legacyRevision === undefined ? {} : { legacyRevision }),
  };
}

export interface CommentAttribution {
  author: string;
  authorLogin?: string;
  authorIdentityKeys: string[];
}

const LEGACY_EMAIL = /([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@[a-z0-9.-]+\.[a-z]{2,}/gi;

function containsLegacyEmail(value: string): boolean {
  LEGACY_EMAIL.lastIndex = 0;
  return LEGACY_EMAIL.test(value);
}

function legacyDisplayName(value: string): string {
  LEGACY_EMAIL.lastIndex = 0;
  return value.replace(LEGACY_EMAIL, (_email, localPart: string) => `${localPart} (legacy)`);
}

export function sanitizeLegacyThreadsForMigration(threads: readonly Thread[]): Thread[] {
  return threads.map((thread) => ({
    ...thread,
    comments: thread.comments.map((comment) => {
      const emailAuthor = containsLegacyEmail(comment.author);
      const emailLogin = Boolean(comment.authorLogin && containsLegacyEmail(comment.authorLogin));
      return {
        ...comment,
        author: legacyDisplayName(comment.author),
        ...(emailAuthor || emailLogin
          ? { authorLogin: undefined }
          : comment.authorLogin
            ? { authorLogin: comment.authorLogin }
            : {}),
      };
    }),
  }));
}

export function attributeLocalComments(
  threads: readonly Thread[],
  attribution: CommentAttribution
): { threads: Thread[]; count: number } {
  if (!attribution.author.trim() || attribution.authorIdentityKeys.length === 0) {
    throw new ReviewMergeError('local-only', 'Publishing local comments requires an attributed identity.');
  }
  const authorIdentityKeys = [...new Set(attribution.authorIdentityKeys)].sort();
  let count = 0;
  const attributed = threads.map((thread) => ({
    ...thread,
    comments: thread.comments.map((comment) => {
      if (!comment.localOnly) return comment;
      if (comment.mentions?.some((mention) => mention.kind === 'resolved')) {
        throw new ReviewMergeError(
          'corruption',
          `Local-only comment ${comment.id} unexpectedly contains a resolved mention.`
        );
      }
      count += 1;
      return {
        ...comment,
        author: attribution.author,
        ...(attribution.authorLogin ? { authorLogin: attribution.authorLogin } : {}),
        authorIdentityKeys,
        identityVersion: 1 as const,
        localOnly: undefined,
      };
    }),
  }));
  return { threads: attributed, count };
}