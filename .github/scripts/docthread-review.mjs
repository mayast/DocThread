import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function v1SidecarPath(docPath) {
  const flat = docPath.replace(/^\/+/, '').replace(/[\\/]/g, '__');
  return `.docthread/${flat}.json`;
}

export function sidecarPath(docPath) {
  return v1SidecarPath(docPath);
}

function repositoryPathSegments(repositoryPath) {
  if (repositoryPath.includes('\\')) {
    throw new Error('Repository paths must use forward slashes, not raw backslashes.');
  }
  const segments = repositoryPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Repository paths cannot contain empty, dot, or dot-dot segments.');
  }
  return segments;
}

function encodePathSegment(segment) {
  try {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    throw new Error('Repository paths must contain valid Unicode code points.');
  }
}

export function v2SidecarPath(repositoryPath) {
  const encoded = repositoryPathSegments(repositoryPath).map(encodePathSegment).join('/');
  return `.docthread/v2/${encoded}.json`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function reviewTargets(changedPaths) {
  const targets = new Map();
  for (const rawPath of changedPaths) {
    const changedPath = rawPath.replace(/^\.\//, '');
    if (/^\.docthread\/v2\/.+\.json$/.test(changedPath)) {
      targets.set(`v2:${changedPath}`, {
        kind: 'v2-sidecar',
        changedPath,
        sidecar: changedPath,
        docPath: null,
      });
      continue;
    }
    if (/^\.docthread\/[^/]+\.json$/.test(changedPath)) {
      targets.set(`v1:${changedPath}`, {
        kind: 'v1-sidecar',
        changedPath,
        sidecar: changedPath,
        docPath: null,
      });
      continue;
    }
    if (!/\.md$/i.test(changedPath)) continue;

    targets.set(`document:${changedPath}`, {
      kind: 'document',
      changedPath,
      docPath: changedPath,
      v2Sidecar: v2SidecarPath(changedPath),
      legacySidecar: v1SidecarPath(changedPath),
    });
  }
  return [...targets.values()].sort((left, right) => compareText(left.changedPath, right.changedPath));
}

function githubSourceUrl(repository, ref, docPath) {
  if (!repository || !ref || !docPath) return null;
  const encodedPath = docPath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${encodedPath}`;
}

function azureReposSourceUrl(options, docPath) {
  if (!options.collectionUri || !options.project || !options.repository || !docPath) return null;
  const base = options.collectionUri.replace(/\/+$/, '');
  const url = new URL(
    `${base}/${encodeURIComponent(options.project)}/_git/${encodeURIComponent(options.repository)}`
  );
  url.searchParams.set('path', `/${docPath.replace(/^\/+/, '')}`);
  if (options.ref) {
    const prefix = /^[0-9a-f]{40}$/i.test(options.ref) ? 'GC' : 'GB';
    url.searchParams.set('version', `${prefix}${options.ref}`);
  }
  url.searchParams.set('_a', 'contents');
  return url.toString();
}

function githubTargetParams(options, docPath) {
  const repository = options.repository?.split('/');
  if (repository?.length !== 2 || repository.some((part) => !part) || !options.ref || !docPath) {
    return null;
  }
  const versionType = /^[0-9a-f]{40}$/i.test(options.ref) ? 'commit' : 'branch';
  const target = {
    kind: 'github',
    owner: repository[0],
    repo: repository[1],
    versionType,
    ref: versionType === 'commit' ? options.ref.toLowerCase() : options.ref,
    path: docPath,
  };
  const params = new URLSearchParams();
  params.set('targetVersion', '1');
  params.set('target', Buffer.from(JSON.stringify(target), 'utf8').toString('base64url'));
  return params;
}

export function reviewDocumentUrl(options, docPath) {
  const provider = options.provider === 'azure-repos' ? 'azure-repos' : 'github';
  const source =
    provider === 'azure-repos'
      ? azureReposSourceUrl(options, docPath)
      : githubSourceUrl(options.repository, options.ref, docPath);
  if (!source || !options.appUrl) return source;
  const app = new URL(options.appUrl);
  if (provider === 'github') {
    const params = githubTargetParams(options, docPath);
    if (!params) return source;
    app.search = params.toString();
    return app.toString();
  }
  app.searchParams.set('source', provider);
  app.searchParams.set('doc', source);
  return app.toString();
}

export function loadConfig(root) {
  const configPath = path.join(root, '.docthread.json');
  if (!fs.existsSync(configPath)) return {};
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('.docthread.json must contain a JSON object.');
  }
  return config;
}

function invalidSidecar(sidecar, location, message) {
  throw new Error(`${sidecar} ${location}: ${message}`);
}

function objectAt(value, sidecar, location) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidSidecar(sidecar, location, 'expected an object.');
  }
  return value;
}

function nonEmptyStringAt(value, sidecar, location) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalidSidecar(sidecar, location, 'expected a non-empty string.');
  }
  return value;
}

function exactKeys(value, allowed, sidecar, location) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) invalidSidecar(sidecar, `${location}.${unknown}`, 'unknown field.');
}

function timestampAt(value, sidecar, location) {
  const timestamp = nonEmptyStringAt(value, sidecar, location);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    invalidSidecar(sidecar, location, 'expected an ISO 8601 UTC timestamp.');
  }
  return new Date(Date.parse(timestamp)).toISOString();
}

function integerAt(value, minimum, sidecar, location) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalidSidecar(sidecar, location, `expected a safe integer >= ${minimum}.`);
  }
  return value;
}

const IDENTITY_KEY = /^(?:github:[^:@\s]+|entra:[^:@\s]+:[^:@\s]+|azure-devops:[^:@\s]+:[^:@\s]+)$/;

function identityKeysAt(value, allowEmpty, sidecar, location) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidSidecar(sidecar, location, 'expected an identity-key array.');
  }
  for (const [index, key] of value.entries()) {
    if (typeof key !== 'string' || !IDENTITY_KEY.test(key)) {
      invalidSidecar(sidecar, `${location}[${index}]`, 'invalid provider identity key.');
    }
  }
  if (new Set(value).size !== value.length) {
    invalidSidecar(sidecar, location, 'duplicate identity key.');
  }
}

function routeAt(value, sidecar, location) {
  const route = objectAt(value, sidecar, location);
  if (route.kind === 'none') {
    exactKeys(route, ['kind'], sidecar, location);
    return;
  }
  if (route.kind === 'github') {
    exactKeys(route, ['kind', 'nodeId'], sidecar, location);
    nonEmptyStringAt(route.nodeId, sidecar, `${location}.nodeId`);
    return;
  }
  if (route.kind === 'ado-work-item') {
    exactKeys(
      route,
      ['kind', 'organization', 'identityId', 'descriptor', 'originId'],
      sidecar,
      location
    );
    for (const key of ['organization', 'identityId', 'descriptor', 'originId']) {
      nonEmptyStringAt(route[key], sidecar, `${location}.${key}`);
    }
    return;
  }
  invalidSidecar(sidecar, `${location}.kind`, 'unknown notification route.');
}

function mentionsAt(value, body, sidecar, location) {
  if (!Array.isArray(value)) invalidSidecar(sidecar, location, 'expected an array.');
  let previousEnd = 0;
  for (const [index, rawMention] of value.entries()) {
    const mentionLocation = `${location}[${index}]`;
    const mention = objectAt(rawMention, sidecar, mentionLocation);
    const start = integerAt(mention.start, 0, sidecar, `${mentionLocation}.start`);
    const length = integerAt(mention.length, 1, sidecar, `${mentionLocation}.length`);
    const text = nonEmptyStringAt(mention.text, sidecar, `${mentionLocation}.text`);
    if (!text.startsWith('@') || length !== text.length || body.slice(start, start + length) !== text) {
      invalidSidecar(sidecar, mentionLocation, 'mention span does not match the comment body.');
    }
    if (start < previousEnd) invalidSidecar(sidecar, location, 'mention spans overlap or are unsorted.');
    previousEnd = start + length;
    if (mention.kind === 'unresolved') {
      exactKeys(mention, ['kind', 'start', 'length', 'text', 'handle'], sidecar, mentionLocation);
      nonEmptyStringAt(mention.handle, sidecar, `${mentionLocation}.handle`);
      continue;
    }
    if (mention.kind !== 'resolved') {
      invalidSidecar(sidecar, `${mentionLocation}.kind`, 'unknown mention kind.');
    }
    exactKeys(
      mention,
      ['kind', 'start', 'length', 'text', 'subjectKey', 'identityKeys', 'authority', 'displayName', 'handle', 'route'],
      sidecar,
      mentionLocation
    );
    nonEmptyStringAt(mention.subjectKey, sidecar, `${mentionLocation}.subjectKey`);
    if (!IDENTITY_KEY.test(mention.subjectKey)) {
      invalidSidecar(sidecar, `${mentionLocation}.subjectKey`, 'invalid provider identity key.');
    }
    identityKeysAt(mention.identityKeys, false, sidecar, `${mentionLocation}.identityKeys`);
    if (!mention.identityKeys.includes(mention.subjectKey)) {
      invalidSidecar(sidecar, `${mentionLocation}.identityKeys`, 'must contain subjectKey.');
    }
    if (!['github', 'entra', 'azure-devops'].includes(mention.authority)) {
      invalidSidecar(sidecar, `${mentionLocation}.authority`, 'unknown identity authority.');
    }
    if (!mention.subjectKey.startsWith(`${mention.authority}:`)) {
      invalidSidecar(sidecar, `${mentionLocation}.authority`, 'does not match subjectKey.');
    }
    nonEmptyStringAt(mention.displayName, sidecar, `${mentionLocation}.displayName`);
    nonEmptyStringAt(mention.handle, sidecar, `${mentionLocation}.handle`);
    routeAt(mention.route, sidecar, `${mentionLocation}.route`);
  }
}

function commentAt(value, sidecar, location) {
  const comment = objectAt(value, sidecar, location);
  exactKeys(
    comment,
    ['id', 'author', 'authorLogin', 'authorIdentityKeys', 'identityVersion', 'localOnly', 'mentions', 'body', 'createdAt', 'dispatch'],
    sidecar,
    location
  );
  nonEmptyStringAt(comment.id, sidecar, `${location}.id`);
  nonEmptyStringAt(comment.author, sidecar, `${location}.author`);
  if (typeof comment.body !== 'string') invalidSidecar(sidecar, `${location}.body`, 'expected a string.');
  timestampAt(comment.createdAt, sidecar, `${location}.createdAt`);
  if (comment.localOnly !== undefined) {
    invalidSidecar(sidecar, `${location}.localOnly`, 'not allowed in a remote sidecar.');
  }
  if (comment.authorLogin !== undefined) {
    nonEmptyStringAt(comment.authorLogin, sidecar, `${location}.authorLogin`);
  }
  if (comment.identityVersion === 1) {
    identityKeysAt(comment.authorIdentityKeys, false, sidecar, `${location}.authorIdentityKeys`);
    mentionsAt(comment.mentions, comment.body, sidecar, `${location}.mentions`);
  } else if (
    comment.identityVersion !== undefined ||
    comment.authorIdentityKeys !== undefined ||
    comment.mentions?.some((mention) => mention?.kind === 'resolved')
  ) {
    invalidSidecar(sidecar, location, 'stable identity metadata requires identityVersion 1.');
  } else if (comment.mentions !== undefined) {
    mentionsAt(comment.mentions, comment.body, sidecar, `${location}.mentions`);
  }
  if (comment.dispatch !== undefined) {
    if (comment.identityVersion !== 1 || !Array.isArray(comment.mentions)) {
      invalidSidecar(sidecar, `${location}.dispatch`, 'requires an identity-aware comment.');
    }
    const dispatch = objectAt(comment.dispatch, sidecar, `${location}.dispatch`);
    exactKeys(
      dispatch,
      ['channel', 'state', 'recipientKeys', 'attemptId', 'attemptedAt', 'providerUrl', 'errorCode'],
      sidecar,
      `${location}.dispatch`
    );
    if (!['github', 'ado-work-item'].includes(dispatch.channel)) {
      invalidSidecar(sidecar, `${location}.dispatch.channel`, 'unknown dispatch channel.');
    }
    if (!['pending', 'attempted', 'delivered', 'failed', 'uncertain'].includes(dispatch.state)) {
      invalidSidecar(sidecar, `${location}.dispatch.state`, 'unknown dispatch state.');
    }
    identityKeysAt(dispatch.recipientKeys, false, sidecar, `${location}.dispatch.recipientKeys`);
    const eligible = new Set(
      comment.mentions
        .filter(
          (mention) => mention.kind === 'resolved' && mention.route?.kind === dispatch.channel
        )
        .map((mention) => mention.subjectKey)
    );
    if (dispatch.recipientKeys.some((key) => !eligible.has(key))) {
      invalidSidecar(
        sidecar,
        `${location}.dispatch.recipientKeys`,
        'contains a subject without a matching resolved route.'
      );
    }
    if (dispatch.state === 'pending') {
      if (dispatch.attemptId !== undefined || dispatch.attemptedAt !== undefined) {
        invalidSidecar(sidecar, `${location}.dispatch`, 'pending state cannot contain claim metadata.');
      }
    } else {
      nonEmptyStringAt(dispatch.attemptId, sidecar, `${location}.dispatch.attemptId`);
      timestampAt(dispatch.attemptedAt, sidecar, `${location}.dispatch.attemptedAt`);
    }
    if (dispatch.providerUrl !== undefined) {
      let providerUrl;
      try {
        providerUrl = new URL(dispatch.providerUrl);
      } catch {
        invalidSidecar(sidecar, `${location}.dispatch.providerUrl`, 'invalid provider URL.');
      }
      if (providerUrl.protocol !== 'https:') {
        invalidSidecar(sidecar, `${location}.dispatch.providerUrl`, 'provider URL must use HTTPS.');
      }
    }
    if (dispatch.errorCode !== undefined) {
      nonEmptyStringAt(dispatch.errorCode, sidecar, `${location}.dispatch.errorCode`);
    }
  }
}

function threadAt(value, sidecar, location) {
  const thread = objectAt(value, sidecar, location);
  exactKeys(
    thread,
    ['id', 'anchor', 'comments', 'resolved', 'createdAt', 'intent', 'clocks', 'deletedAt', 'located', 'confidence'],
    sidecar,
    location
  );
  nonEmptyStringAt(thread.id, sidecar, `${location}.id`);
  const anchor = objectAt(thread.anchor, sidecar, `${location}.anchor`);
  exactKeys(anchor, ['quote', 'prefix', 'suffix', 'start'], sidecar, `${location}.anchor`);
  for (const key of ['quote', 'prefix', 'suffix']) {
    if (typeof anchor[key] !== 'string') invalidSidecar(sidecar, `${location}.anchor.${key}`, 'expected a string.');
  }
  integerAt(anchor.start, 0, sidecar, `${location}.anchor.start`);
  if (!Array.isArray(thread.comments)) invalidSidecar(sidecar, `${location}.comments`, 'expected an array.');
  thread.comments.forEach((comment, index) => commentAt(comment, sidecar, `${location}.comments[${index}]`));
  if (new Set(thread.comments.map((comment) => comment.id)).size !== thread.comments.length) {
    invalidSidecar(sidecar, `${location}.comments`, 'duplicate comment ID.');
  }
  if (typeof thread.resolved !== 'boolean') invalidSidecar(sidecar, `${location}.resolved`, 'expected a boolean.');
  const createdAt = timestampAt(thread.createdAt, sidecar, `${location}.createdAt`);
  if (thread.intent !== undefined && !['question', 'suggestion', 'blocking'].includes(thread.intent)) {
    invalidSidecar(sidecar, `${location}.intent`, 'unknown thread intent.');
  }
  if (thread.clocks !== undefined) {
    const clocks = objectAt(thread.clocks, sidecar, `${location}.clocks`);
    exactKeys(clocks, ['resolutionAt', 'intentAt', 'anchorAt'], sidecar, `${location}.clocks`);
    for (const key of Object.keys(clocks)) timestampAt(clocks[key], sidecar, `${location}.clocks.${key}`);
  }
  if (thread.deletedAt !== undefined) {
    const deletedAt = timestampAt(thread.deletedAt, sidecar, `${location}.deletedAt`);
    if (deletedAt < createdAt) invalidSidecar(sidecar, `${location}.deletedAt`, 'cannot predate creation.');
  }
  if (thread.located !== undefined && typeof thread.located !== 'boolean') {
    invalidSidecar(sidecar, `${location}.located`, 'expected a boolean.');
  }
  if (
    thread.confidence !== undefined &&
    !['exact', 'high', 'medium', 'needs-confirmation', 'orphaned'].includes(thread.confidence)
  ) {
    invalidSidecar(sidecar, `${location}.confidence`, 'unknown anchor confidence.');
  }
}

function decodeReviewSidecar(value, sidecar, options = {}) {
  const file = objectAt(value, sidecar, '$');
  if (file.schemaVersion !== 1 && file.schemaVersion !== 2) {
    invalidSidecar(sidecar, '$.schemaVersion', 'unknown or missing DocThread schema version.');
  }
  if (options.expectedVersion && file.schemaVersion !== options.expectedVersion) {
    invalidSidecar(
      sidecar,
      '$.schemaVersion',
      `expected schema version ${options.expectedVersion}, received ${file.schemaVersion}.`
    );
  }

  exactKeys(
    file,
    file.schemaVersion === 1
      ? ['schemaVersion', 'docPath', 'threads', 'updatedAt', 'markdown', 'meta']
      : ['schemaVersion', 'source', 'docPath', 'threads', 'updatedAt', 'markdown', 'meta', 'legacyPath', 'legacyRevision'],
    sidecar,
    '$'
  );
  nonEmptyStringAt(file.docPath, sidecar, '$.docPath');
  timestampAt(file.updatedAt, sidecar, '$.updatedAt');
  if (!Array.isArray(file.threads)) {
    invalidSidecar(sidecar, '$.threads', 'expected an array.');
  }
  if (file.markdown !== undefined && typeof file.markdown !== 'string') {
    invalidSidecar(sidecar, '$.markdown', 'expected a string.');
  }
  if (file.meta !== undefined) {
    const meta = objectAt(file.meta, sidecar, '$.meta');
    exactKeys(meta, ['source', 'title', 'sourceUrl'], sidecar, '$.meta');
    if (
      meta.source !== undefined &&
      !['github', 'azure-repos', 'ado-workitem', 'ado'].includes(meta.source)
    ) {
      invalidSidecar(sidecar, '$.meta.source', 'unknown source.');
    }
    for (const key of ['title', 'sourceUrl']) {
      if (meta[key] !== undefined) nonEmptyStringAt(meta[key], sidecar, `$.meta.${key}`);
    }
  }
  file.threads.forEach((thread, index) => threadAt(thread, sidecar, `$.threads[${index}]`));
  if (new Set(file.threads.map((thread) => thread.id)).size !== file.threads.length) {
    invalidSidecar(sidecar, '$.threads', 'duplicate thread ID.');
  }
  const commentIds = file.threads.flatMap((thread) => thread.comments.map((comment) => comment.id));
  if (new Set(commentIds).size !== commentIds.length) {
    invalidSidecar(sidecar, '$.threads', 'comment IDs must be unique across the file.');
  }

  if (file.schemaVersion === 1) return file;

  const source = objectAt(file.source, sidecar, '$.source');
  const sourceKeys = Object.keys(source);
  if (sourceKeys.length !== 2 || !sourceKeys.includes('provider') || !sourceKeys.includes('path')) {
    invalidSidecar(sidecar, '$.source', 'expected exactly provider and path.');
  }
  if (source.provider !== 'github' && source.provider !== 'azure-repos') {
    invalidSidecar(sidecar, '$.source.provider', 'unknown repository provider.');
  }
  const sourcePath = nonEmptyStringAt(source.path, sidecar, '$.source.path');
  try {
    v2SidecarPath(sourcePath);
  } catch (error) {
    invalidSidecar(
      sidecar,
      '$.source.path',
      error instanceof Error ? error.message : 'invalid repository path.'
    );
  }
  if (options.expectedProvider && source.provider !== options.expectedProvider) {
    invalidSidecar(
      sidecar,
      '$.source.provider',
      `expected ${options.expectedProvider}, received ${source.provider}.`
    );
  }
  if (options.expectedPath && sourcePath !== options.expectedPath) {
    invalidSidecar(
      sidecar,
      '$.source.path',
      `does not exactly match the expected raw document path ${JSON.stringify(options.expectedPath)}.`
    );
  }
  if ((file.legacyPath === undefined) !== (file.legacyRevision === undefined)) {
    invalidSidecar(sidecar, '$', 'legacyPath and legacyRevision must be present together.');
  }
  if (file.legacyPath !== undefined) {
    nonEmptyStringAt(file.legacyPath, sidecar, '$.legacyPath');
    nonEmptyStringAt(file.legacyRevision, sidecar, '$.legacyRevision');
  }
  return file;
}

function sidecarFilePath(root, sidecar) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...sidecar.split('/'));
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Sidecar path escapes the repository root: ${sidecar}`);
  }
  return resolvedPath;
}

function sidecarExists(root, sidecar) {
  return fs.existsSync(sidecarFilePath(root, sidecar));
}

function readSidecar(root, sidecar, options = {}) {
  const fullPath = sidecarFilePath(root, sidecar);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Changed DocThread sidecar does not exist in the worktree: ${sidecar}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${sidecar} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return decodeReviewSidecar(parsed, sidecar, options);
}

function configuredProvider(options) {
  return options.provider === 'azure-repos' ? 'azure-repos' : 'github';
}

function azureOrganization(collectionUri) {
  if (!collectionUri) return null;
  try {
    const url = new URL(collectionUri);
    if (url.hostname.toLowerCase() === 'dev.azure.com') {
      const [organization] = url.pathname.replace(/^\/+/, '').split('/');
      return organization ? decodeURIComponent(organization) : null;
    }
    const suffix = '.visualstudio.com';
    if (url.hostname.toLowerCase().endsWith(suffix)) {
      return decodeURIComponent(url.hostname.slice(0, -suffix.length));
    }
  } catch {
    return null;
  }
  return null;
}

function legacyRepositoryLabel(options, provider) {
  if (!options.repository) return null;
  if (provider === 'github') return options.repository;
  const organization = azureOrganization(options.collectionUri);
  if (!organization || !options.project) return null;
  return `${organization}/${options.project}/${options.repository}`;
}

function exactLegacyStorageKey(options, provider, docPath) {
  const repository = legacyRepositoryLabel(options, provider);
  if (!repository || !options.ref) return null;
  return `${repository}/${docPath}@${options.ref}`;
}

function legacyMatchesExpectedPath(legacy, expectedPath, options, provider) {
  if (legacy.docPath === expectedPath) return true;
  const storageKey = exactLegacyStorageKey(options, provider, expectedPath);
  return storageKey !== null && legacy.docPath === storageKey;
}

function directLegacyDocumentPath(legacy, sidecar, options, provider) {
  try {
    if (v1SidecarPath(legacy.docPath) === sidecar) {
      v2SidecarPath(legacy.docPath);
      return legacy.docPath;
    }
  } catch {
    // Try the exact provider/ref storage-key form below.
  }

  const repository = legacyRepositoryLabel(options, provider);
  if (!repository || !options.ref) return null;
  const prefix = `${repository}/`;
  const suffix = `@${options.ref}`;
  if (!legacy.docPath.startsWith(prefix) || !legacy.docPath.endsWith(suffix)) return null;
  const documentPath = legacy.docPath.slice(prefix.length, -suffix.length);
  try {
    v2SidecarPath(documentPath);
  } catch {
    return null;
  }
  return v1SidecarPath(documentPath) === sidecar ? documentPath : null;
}

export function collectReviewStatus(root, changedPaths, options = {}) {
  const documents = [];
  const missing = [];
  const warnings = [];
  const warningSet = new Set();
  const targets = reviewTargets(changedPaths);
  const changedSidecars = new Set(
    targets.filter((target) => target.sidecar).map((target) => target.sidecar)
  );
  const documentPaths = new Set();
  const provider = configuredProvider(options);

  const addWarning = (warning) => {
    if (warningSet.has(warning)) return;
    warningSet.add(warning);
    warnings.push(warning);
  };

  for (const target of targets) {
    if (target.kind === 'document') {
      documentPaths.add(target.docPath);
      continue;
    }

    if (target.kind === 'v2-sidecar') {
      const sidecar = readSidecar(root, target.sidecar, {
        expectedVersion: 2,
        expectedProvider: provider,
      });
      const documentPath = sidecar.source.path;
      const expectedSidecar = v2SidecarPath(documentPath);
      if (target.sidecar !== expectedSidecar) {
        invalidSidecar(
          target.sidecar,
          '$.source.path',
          `maps to ${expectedSidecar}, not the changed v2 sidecar path.`
        );
      }
      documentPaths.add(documentPath);
      continue;
    }

    const legacy = readSidecar(root, target.sidecar, { expectedVersion: 1 });
    const documentPath = directLegacyDocumentPath(legacy, target.sidecar, options, provider);
    if (documentPath) {
      documentPaths.add(documentPath);
    } else {
      addWarning(
        `Legacy sidecar \`${target.sidecar}\` was quarantined because its persisted docPath does not map exactly to that file; no path was inferred from the lossy v1 filename.`
      );
    }
  }

  for (const docPath of [...documentPaths].sort(compareText)) {
    const v2Sidecar = v2SidecarPath(docPath);
    const legacySidecar = v1SidecarPath(docPath);
    let sidecar;
    let parsed;
    if (sidecarExists(root, v2Sidecar)) {
      sidecar = v2Sidecar;
      parsed = readSidecar(root, v2Sidecar, {
        expectedVersion: 2,
        expectedProvider: provider,
        expectedPath: docPath,
      });
      if (parsed.legacyPath !== undefined && parsed.legacyPath !== legacySidecar) {
        invalidSidecar(
          v2Sidecar,
          '$.legacyPath',
          `expected ${legacySidecar}, received ${parsed.legacyPath}.`
        );
      }
      if (parsed.legacyPath && changedSidecars.has(parsed.legacyPath)) {
        addWarning(
          `Legacy client changes need reconciliation for \`${docPath}\`: \`${parsed.legacyPath}\` changed while schema v2 is authoritative, and its recorded legacyRevision cannot be compared from the worktree alone.`
        );
      }
    } else if (sidecarExists(root, legacySidecar)) {
      const legacy = readSidecar(root, legacySidecar, { expectedVersion: 1 });
      if (!legacyMatchesExpectedPath(legacy, docPath, options, provider)) {
        addWarning(
          `Legacy sidecar \`${legacySidecar}\` was quarantined because its persisted docPath does not exactly match \`${docPath}\`; the v1 filename may collide.`
        );
        continue;
      }
      sidecar = legacySidecar;
      parsed = legacy;
    } else {
      missing.push({ sidecar: v2Sidecar, legacySidecar, docPath });
      continue;
    }

    const openThreads = parsed.threads.filter(
      (thread) => thread.deletedAt === undefined && !thread.resolved
    );
    documents.push({
      sidecar,
      docPath,
      url: reviewDocumentUrl(options, docPath),
      open: openThreads.length,
      blocking: openThreads.filter((thread) => thread.intent === 'blocking').length,
    });
  }

  return {
    documents,
    missing,
    warnings,
    open: documents.reduce((sum, document) => sum + document.open, 0),
    blocking: documents.reduce((sum, document) => sum + document.blocking, 0),
  };
}

export function formatTitle(status) {
  return `DocThread review: ${status.open} open, ${status.blocking} blocking`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n]+/g, ' ');
}

function escapeMarkdownText(value) {
  return String(value).replace(/[\\`*_[\]{}()#+\-.!|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export function formatSummary(status) {
  const lines = [
    '## DocThread review',
    '',
    `**${status.open} open | ${status.blocking} blocking**`,
    '',
  ];

  if (status.documents.length > 0) {
    lines.push('| Document | Open | Blocking |', '| --- | ---: | ---: |');
    for (const document of status.documents) {
      const label = document.docPath || document.sidecar;
      const escapedLabel = escapeHtml(label);
      const link = document.url
        ? `<a href="${escapeHtml(document.url)}">Open document</a><br><code>${escapedLabel}</code>`
        : `<code>${escapedLabel}</code>`;
      lines.push(`| ${link} | ${document.open} | ${document.blocking} |`);
    }
    lines.push('');
  }

  if (status.missing.length > 0) {
    lines.push('### Changed documents without a review sidecar', '');
    for (const target of status.missing) {
      lines.push(`- <code>${escapeHtml(target.docPath || target.sidecar)}</code>`);
    }
    lines.push('');
  }

  if (status.warnings?.length > 0) {
    lines.push('### Review warnings', '');
    for (const warning of status.warnings) {
      lines.push(`- ${escapeMarkdownText(warning)}`);
    }
    lines.push('');
  }

  if (
    status.documents.length === 0 &&
    status.missing.length === 0 &&
    (status.warnings?.length ?? 0) === 0
  ) {
    lines.push('No changed Markdown documents or DocThread sidecars were found.', '');
  }

  lines.push('This check is reporting-only. Blocking threads do not fail the pull request.');
  return lines.join('\n');
}

function changedPathsFromGit(baseSha, headSha) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${baseSha}...${headSha}`],
    { encoding: 'utf8' }
  );
  return output.split(/\r?\n/).filter(Boolean);
}

function appendOutput(filePath, name, value) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${name}=${value}\n`);
}

function main() {
  const baseSha = process.env.DOCTHREAD_BASE_SHA;
  const headSha = process.env.DOCTHREAD_HEAD_SHA;
  if (!baseSha || !headSha) {
    throw new Error('DOCTHREAD_BASE_SHA and DOCTHREAD_HEAD_SHA are required.');
  }

  const root = process.cwd();
  const config = loadConfig(root);
  const status = collectReviewStatus(root, changedPathsFromGit(baseSha, headSha), {
    provider: process.env.DOCTHREAD_PROVIDER || config.provider,
    appUrl: process.env.DOCTHREAD_APP_URL || config.appUrl,
    collectionUri: process.env.DOCTHREAD_COLLECTION_URI || config.collectionUri,
    project: process.env.DOCTHREAD_PROJECT || config.project,
    repository: process.env.DOCTHREAD_REPOSITORY || config.repository,
    ref: process.env.DOCTHREAD_REF || headSha,
  });
  const title = formatTitle(status);
  const summary = formatSummary(status);
  const summaryPath = path.resolve(
    process.env.DOCTHREAD_SUMMARY_PATH || '.docthread-review-summary.md'
  );
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${summary}\n`, 'utf8');

  appendOutput(process.env.GITHUB_OUTPUT, 'title', title);
  appendOutput(process.env.GITHUB_OUTPUT, 'open', String(status.open));
  appendOutput(process.env.GITHUB_OUTPUT, 'blocking', String(status.blocking));
  appendOutput(process.env.GITHUB_OUTPUT, 'missing', String(status.missing.length));
  appendOutput(process.env.GITHUB_OUTPUT, 'summary_path', summaryPath);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({ title, ...status }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
