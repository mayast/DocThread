import type { GitHubSourceTarget, GitHubVersionType } from './types.ts';

export const MAX_GITHUB_URL_TAIL_SEGMENTS = 64;
export const MAX_GITHUB_RESOLUTION_CANDIDATES = 64;
export const MAX_PUBLIC_GITHUB_RESOLUTION_PROBES = 8;
export const MAX_GITHUB_DEEP_LINK_TARGET_BYTES = 8 * 1024;

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface GitHubRefPathBoundary {
  ref: string;
  path: string;
}

export interface ParsedGitHubSourceUrl {
  kind: 'github-provisional';
  owner: string;
  repo: string;
  boundary: 'encoded-ref' | 'ambiguous';
  candidates: readonly GitHubRefPathBoundary[];
}

export interface VerifiedGitHubSourceTarget extends GitHubSourceTarget {
  commitSha: string;
}

export type GitHubSourceResolution =
  | {
      status: 'resolved';
      target: VerifiedGitHubSourceTarget;
    }
  | {
      status: 'ambiguous';
      candidates: readonly VerifiedGitHubSourceTarget[];
    };

export type GitHubSourceResolutionErrorCode =
  | 'invalid-url'
  | 'candidate-limit'
  | 'no-match'
  | 'request-failed';

export class GitHubSourceResolutionError extends Error {
  readonly code: GitHubSourceResolutionErrorCode;

  constructor(code: GitHubSourceResolutionErrorCode, message: string) {
    super(message);
    this.name = 'GitHubSourceResolutionError';
    this.code = code;
  }
}

export interface GitHubGraphQLRequest {
  query: string;
  variables: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export type GitHubGraphQLExecutor = (request: GitHubGraphQLRequest) => Promise<unknown>;

interface GitHubRestObject {
  type?: string;
  sha?: string;
}

async function publicGitHubJson(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ found: boolean; value: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
  });
  if (response.status === 404) return { found: false, value: {} };
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new GitHubSourceResolutionError(
      'request-failed',
      (typeof value.message === 'string' && value.message) ||
        `Public GitHub source resolution failed (${response.status}).`
    );
  }
  return { found: true, value };
}

async function publicCommitSha(
  apiRoot: string,
  object: GitHubRestObject,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string | null> {
  let current = object;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current.type === 'commit' && current.sha && COMMIT_SHA.test(current.sha)) {
      return current.sha.toLowerCase();
    }
    if (current.type !== 'tag' || !current.sha) return null;
    const tag = await publicGitHubJson(
      `${apiRoot}/git/tags/${encodeURIComponent(current.sha)}`,
      fetchImpl,
      signal
    );
    if (!tag.found) return null;
    current = (record(tag.value.object) || {}) as GitHubRestObject;
  }
  return null;
}

/**
 * Public-only fallback for source resolution. It reproduces the GraphQL probe
 * response shape using bounded unauthenticated REST calls, preserving exact
 * branch/tag/commit distinctions without relying on raw-URL precedence.
 */
export async function executePublicGitHubResolutionRequest(
  request: GitHubGraphQLRequest,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const owner = request.variables.owner;
  const repo = request.variables.repo;
  if (!owner || !repo) {
    throw new GitHubSourceResolutionError('invalid-url', 'GitHub repository identity is missing.');
  }
  const probeCount = Object.keys(request.variables).filter((key) => /^revision\d+$/.test(key)).length;
  if (probeCount > MAX_PUBLIC_GITHUB_RESOLUTION_PROBES) {
    throw new GitHubSourceResolutionError(
      'candidate-limit',
      `Public GitHub resolution is limited to ${MAX_PUBLIC_GITHUB_RESOLUTION_PROBES} exact ref probes; sign in to resolve a more ambiguous URL.`
    );
  }
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repository: Record<string, unknown> = {};

  for (let index = 0; index < MAX_PUBLIC_GITHUB_RESOLUTION_PROBES; index += 1) {
    const revision = request.variables[`revision${index}`];
    const expression = request.variables[`expression${index}`];
    if (!revision || !expression) break;
    const path = expression.slice(revision.length + 1);
    let commitSha: string | null = null;

    if (COMMIT_SHA.test(revision)) {
      const commit = await publicGitHubJson(
        `${apiRoot}/git/commits/${encodeURIComponent(revision)}`,
        fetchImpl,
        request.signal
      );
      if (commit.found) commitSha = revision.toLowerCase();
      if (commitSha) {
        repository[`probe${index}Revision`] = { __typename: 'Commit', oid: commitSha };
      }
    } else {
      const restRef = revision.startsWith('refs/') ? revision.slice('refs/'.length) : revision;
      const encodedRef = restRef.split('/').map(encodeURIComponent).join('/');
      const reference = await publicGitHubJson(
        `${apiRoot}/git/ref/${encodedRef}`,
        fetchImpl,
        request.signal
      );
      if (reference.found) {
        commitSha = await publicCommitSha(
          apiRoot,
          (record(reference.value.object) || {}) as GitHubRestObject,
          fetchImpl,
          request.signal
        );
      }
      if (commitSha) {
        repository[`probe${index}Revision`] = {
          target: { __typename: 'Commit', oid: commitSha },
        };
      }
    }

    if (!commitSha) continue;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const file = await publicGitHubJson(
      `${apiRoot}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`,
      fetchImpl,
      request.signal
    );
    if (file.found && file.value.type === 'file' && typeof file.value.sha === 'string') {
      repository[`probe${index}File`] = { __typename: 'Blob', oid: file.value.sha };
    }
  }
  return { data: { repository } };
}

function invalidUrl(message: string): never {
  throw new GitHubSourceResolutionError('invalid-url', message);
}

function decodeSegment(raw: string, allowSlash: boolean): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalidUrl('GitHub URL path contains malformed percent encoding.');
  }
  if (
    !decoded ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    (!allowSlash && decoded.includes('/'))
  ) {
    return invalidUrl('GitHub URL contains an invalid encoded path segment.');
  }
  const parts = allowSlash ? decoded.split('/') : [decoded];
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return invalidUrl('GitHub URL contains an invalid dot or empty path segment.');
  }
  return decoded;
}

function hasEncodedSlash(raw: string): boolean {
  return /%2f/i.test(raw);
}

function rawPathSegments(url: URL): string[] {
  if (!url.pathname.startsWith('/')) return invalidUrl('GitHub URL path is invalid.');
  const segments = url.pathname.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return invalidUrl('GitHub URL path contains an empty segment.');
  }
  return segments;
}

function parseGitHubSourceUrlOrThrow(value: string): ParsedGitHubSourceUrl {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return invalidUrl('GitHub source URL is invalid.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password
  ) {
    return invalidUrl('GitHub source URL must use HTTP(S) without embedded credentials.');
  }

  const host = url.hostname.toLowerCase();
  const segments = rawPathSegments(url);
  let ownerRaw: string;
  let repoRaw: string;
  let tail: string[];

  if (host === 'github.com' || host === 'www.github.com') {
    if (segments.length < 5 || !['blob', 'raw'].includes(segments[2].toLowerCase())) {
      return invalidUrl('GitHub source URL must identify a blob or raw file.');
    }
    [ownerRaw, repoRaw] = segments;
    tail = segments.slice(3);
  } else if (host === 'raw.githubusercontent.com') {
    if (segments.length < 4) {
      return invalidUrl('Raw GitHub URL must identify a ref and file path.');
    }
    [ownerRaw, repoRaw] = segments;
    tail = segments.slice(2);
  } else {
    return invalidUrl('GitHub source URL host is not supported.');
  }

  if (tail.length < 2) {
    return invalidUrl('GitHub source URL must include a ref and file path.');
  }
  if (tail.length > MAX_GITHUB_URL_TAIL_SEGMENTS) {
    throw new GitHubSourceResolutionError(
      'candidate-limit',
      `GitHub URL exceeds the ${MAX_GITHUB_URL_TAIL_SEGMENTS}-segment resolution limit.`
    );
  }

  const owner = decodeSegment(ownerRaw, false);
  const repo = decodeSegment(repoRaw, false);
  const encodedRef = hasEncodedSlash(tail[0]);
  if (tail.slice(1).some(hasEncodedSlash)) {
    return invalidUrl('Encoded slashes are not allowed in GitHub file path segments.');
  }

  if (encodedRef) {
    const ref = decodeSegment(tail[0], true);
    const path = tail
      .slice(1)
      .map((segment) => decodeSegment(segment, false))
      .join('/');
    return {
      kind: 'github-provisional',
      owner,
      repo,
      boundary: 'encoded-ref',
      candidates: [{ ref, path }],
    };
  }

  const decodedTail = tail.map((segment) => decodeSegment(segment, false));
  const candidates = decodedTail.slice(0, -1).map((_, boundary) => ({
    ref: decodedTail.slice(0, boundary + 1).join('/'),
    path: decodedTail.slice(boundary + 1).join('/'),
  }));
  if (candidates.length > MAX_GITHUB_RESOLUTION_CANDIDATES) {
    throw new GitHubSourceResolutionError(
      'candidate-limit',
      `GitHub URL exceeds the ${MAX_GITHUB_RESOLUTION_CANDIDATES}-candidate resolution limit.`
    );
  }
  return {
    kind: 'github-provisional',
    owner,
    repo,
    boundary: 'ambiguous',
    candidates,
  };
}

/** Parses raw encoded GitHub path segments without guessing a ref/path boundary. */
export function parseGitHubSourceUrl(value: string): ParsedGitHubSourceUrl | null {
  try {
    return parseGitHubSourceUrlOrThrow(value);
  } catch (error) {
    if (error instanceof GitHubSourceResolutionError) return null;
    throw error;
  }
}

interface ResolutionProbe extends GitHubRefPathBoundary {
  versionType: GitHubVersionType;
}

function resolutionProbes(parsed: ParsedGitHubSourceUrl): ResolutionProbe[] {
  const probes: ResolutionProbe[] = [];
  for (const candidate of parsed.candidates) {
    probes.push({ ...candidate, versionType: 'branch' });
    probes.push({ ...candidate, versionType: 'tag' });
    if (COMMIT_SHA.test(candidate.ref)) {
      probes.push({ ...candidate, versionType: 'commit' });
    }
    if (probes.length > MAX_GITHUB_RESOLUTION_CANDIDATES) {
      throw new GitHubSourceResolutionError(
        'candidate-limit',
        `GitHub URL exceeds the ${MAX_GITHUB_RESOLUTION_CANDIDATES}-candidate resolution limit.`
      );
    }
  }
  return probes;
}

const REF_TARGET_SELECTION = `
  target {
    __typename
    ... on Commit { oid }
    ... on Tag {
      target {
        __typename
        ... on Commit { oid }
        ... on Tag {
          target {
            __typename
            ... on Commit { oid }
          }
        }
      }
    }
  }
`;

function buildResolutionRequest(
  parsed: ParsedGitHubSourceUrl,
  probes: readonly ResolutionProbe[],
  signal?: AbortSignal
): GitHubGraphQLRequest {
  const declarations = ['$owner: String!', '$repo: String!'];
  const fields: string[] = [];
  const variables: Record<string, string> = { owner: parsed.owner, repo: parsed.repo };

  probes.forEach((probe, index) => {
    const revision =
      probe.versionType === 'commit'
        ? probe.ref
        : `refs/${probe.versionType === 'branch' ? 'heads' : 'tags'}/${probe.ref}`;
    const revisionVariable = `revision${index}`;
    const expressionVariable = `expression${index}`;
    variables[revisionVariable] = revision;
    variables[expressionVariable] = `${revision}:${probe.path}`;
    declarations.push(
      `$${revisionVariable}: ${probe.versionType === 'commit' ? 'GitObjectID' : 'String'}!`,
      `$${expressionVariable}: String!`
    );
    fields.push(
      probe.versionType === 'commit'
        ? `probe${index}Revision: object(oid: $${revisionVariable}) { __typename ... on Commit { oid } }`
        : `probe${index}Revision: ref(qualifiedName: $${revisionVariable}) { ${REF_TARGET_SELECTION} }`,
      `probe${index}File: object(expression: $${expressionVariable}) { __typename ... on Blob { oid } }`
    );
  });

  return {
    query: `
      query DocThreadResolveGitHubSource(${declarations.join(', ')}) {
        repository(owner: $owner, name: $repo) {
          ${fields.join('\n')}
        }
      }
    `,
    variables,
    signal,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function commitOid(value: unknown, depth = 0): string | null {
  const object = record(value);
  if (!object || depth > 3) return null;
  if (object.__typename === 'Commit' && typeof object.oid === 'string' && COMMIT_SHA.test(object.oid)) {
    return object.oid.toLowerCase();
  }
  return object.__typename === 'Tag' ? commitOid(object.target, depth + 1) : null;
}

function responseError(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.errors) || payload.errors.length === 0) return null;
  const first = record(payload.errors[0]);
  return typeof first?.message === 'string' ? first.message : 'GitHub GraphQL resolution failed.';
}

function verifiedTargets(
  parsed: ParsedGitHubSourceUrl,
  probes: readonly ResolutionProbe[],
  payloadValue: unknown
): VerifiedGitHubSourceTarget[] {
  const payload = record(payloadValue);
  if (!payload) {
    throw new GitHubSourceResolutionError('request-failed', 'GitHub GraphQL returned no payload.');
  }
  const graphError = responseError(payload);
  if (graphError) throw new GitHubSourceResolutionError('request-failed', graphError);
  const repository = record(record(payload.data)?.repository);
  if (!repository) return [];

  const verified: VerifiedGitHubSourceTarget[] = [];
  const seen = new Set<string>();
  probes.forEach((probe, index) => {
    const revision = record(repository[`probe${index}Revision`]);
    const file = record(repository[`probe${index}File`]);
    if (file?.__typename !== 'Blob') return;
    const sha =
      probe.versionType === 'commit'
        ? commitOid(revision)
        : commitOid(record(revision)?.target);
    if (!sha || (probe.versionType === 'commit' && sha !== probe.ref.toLowerCase())) return;
    const ref = probe.versionType === 'commit' ? sha : probe.ref;
    const key = `${probe.versionType}\0${ref}\0${probe.path}\0${sha}`;
    if (seen.has(key)) return;
    seen.add(key);
    verified.push({
      kind: 'github',
      owner: parsed.owner,
      repo: parsed.repo,
      versionType: probe.versionType,
      ref,
      path: probe.path,
      commitSha: sha,
    });
  });
  return verified;
}

/** Resolves every bounded ref/path candidate in one GraphQL operation. */
export async function resolveParsedGitHubSourceUrl(
  parsed: ParsedGitHubSourceUrl,
  executeGraphQL: GitHubGraphQLExecutor,
  options: { signal?: AbortSignal } = {}
): Promise<GitHubSourceResolution> {
  const probes = resolutionProbes(parsed);
  let payload: unknown;
  try {
    payload = await executeGraphQL(buildResolutionRequest(parsed, probes, options.signal));
  } catch (error) {
    throw new GitHubSourceResolutionError(
      'request-failed',
      error instanceof Error ? error.message : 'GitHub GraphQL resolution failed.'
    );
  }
  const candidates = verifiedTargets(parsed, probes, payload);
  if (candidates.length === 0) {
    throw new GitHubSourceResolutionError(
      'no-match',
      'GitHub URL does not resolve to a file at an exact branch, tag, or commit.'
    );
  }
  return candidates.length === 1
    ? { status: 'resolved', target: candidates[0] }
    : { status: 'ambiguous', candidates };
}

export async function resolveGitHubSourceUrl(
  value: string,
  executeGraphQL: GitHubGraphQLExecutor,
  options: { signal?: AbortSignal } = {}
): Promise<GitHubSourceResolution> {
  return resolveParsedGitHubSourceUrl(
    parseGitHubSourceUrlOrThrow(value),
    executeGraphQL,
    options
  );
}

/** Verifies one already-canonical branch, tag, or commit target exactly. */
export async function verifyGitHubSourceTarget(
  target: GitHubSourceTarget,
  executeGraphQL: GitHubGraphQLExecutor,
  options: { signal?: AbortSignal } = {}
): Promise<VerifiedGitHubSourceTarget> {
  const canonical = canonicalTarget({
    kind: target.kind,
    owner: target.owner,
    repo: target.repo,
    versionType: target.versionType,
    ref: target.ref,
    path: target.path,
  });
  const parsed: ParsedGitHubSourceUrl = {
    kind: 'github-provisional',
    owner: canonical.owner,
    repo: canonical.repo,
    boundary: 'encoded-ref',
    candidates: [{ ref: canonical.ref, path: canonical.path }],
  };
  const probes: ResolutionProbe[] = [
    { ref: canonical.ref, path: canonical.path, versionType: canonical.versionType },
  ];
  let payload: unknown;
  try {
    payload = await executeGraphQL(buildResolutionRequest(parsed, probes, options.signal));
  } catch (error) {
    throw new GitHubSourceResolutionError(
      'request-failed',
      error instanceof Error ? error.message : 'GitHub GraphQL resolution failed.'
    );
  }
  const [verified] = verifiedTargets(parsed, probes, payload);
  if (!verified) {
    throw new GitHubSourceResolutionError(
      'no-match',
      'Canonical GitHub target does not resolve to a file at the exact ref.'
    );
  }
  return verified;
}

export type GitHubTargetDeepLinkErrorCode =
  | 'invalid-version'
  | 'invalid-target'
  | 'target-too-large';

export class GitHubTargetDeepLinkError extends Error {
  readonly code: GitHubTargetDeepLinkErrorCode;

  constructor(code: GitHubTargetDeepLinkErrorCode, message: string) {
    super(message);
    this.name = 'GitHubTargetDeepLinkError';
    this.code = code;
  }
}

function validIdentitySegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/\0]/.test(value)
  );
}

function validRepositoryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => validIdentitySegment(segment));
}

function validRef(value: unknown, versionType: GitHubVersionType): value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (versionType === 'commit') return COMMIT_SHA.test(value);
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function assertWellFormedUnicode(values: readonly string[]): void {
  try {
    values.forEach((value) => encodeURIComponent(value));
  } catch {
    throw new GitHubTargetDeepLinkError(
      'invalid-target',
      'GitHub deep-link target contains invalid Unicode.'
    );
  }
}

function canonicalTarget(value: unknown): GitHubSourceTarget {
  const object = record(value);
  const keys = object ? Object.keys(object).sort() : [];
  const expectedKeys = ['kind', 'owner', 'path', 'ref', 'repo', 'versionType'];
  if (!object || keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target shape is invalid.');
  }
  const versionType = object.versionType;
  if (versionType !== 'branch' && versionType !== 'tag' && versionType !== 'commit') {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link version type is invalid.');
  }
  if (
    object.kind !== 'github' ||
    !validIdentitySegment(object.owner) ||
    !validIdentitySegment(object.repo) ||
    !validRepositoryPath(object.path) ||
    !validRef(object.ref, versionType)
  ) {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target is invalid.');
  }
  assertWellFormedUnicode([object.owner, object.repo, object.ref, object.path]);
  return {
    kind: 'github',
    owner: object.owner,
    repo: object.repo,
    versionType,
    ref: versionType === 'commit' ? object.ref.toLowerCase() : object.ref,
    path: object.path,
  };
}

function canonicalTargetJson(target: GitHubSourceTarget): string {
  return JSON.stringify({
    kind: target.kind,
    owner: target.owner,
    repo: target.repo,
    versionType: target.versionType,
    ref: target.ref,
    path: target.path,
  });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target encoding is invalid.');
  }
  if (value.length > Math.ceil((MAX_GITHUB_DEEP_LINK_TARGET_BYTES * 4) / 3) + 4) {
    throw new GitHubTargetDeepLinkError('target-too-large', 'GitHub deep-link target is too large.');
  }
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '='));
  } catch {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target encoding is invalid.');
  }
  if (binary.length > MAX_GITHUB_DEEP_LINK_TARGET_BYTES) {
    throw new GitHubTargetDeepLinkError('target-too-large', 'GitHub deep-link target is too large.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Encodes transport data only; this value is not a signature or authenticity proof. */
export function encodeGitHubSourceTarget(target: GitHubSourceTarget): string {
  const canonical = canonicalTarget({
    kind: target.kind,
    owner: target.owner,
    repo: target.repo,
    versionType: target.versionType,
    ref: target.ref,
    path: target.path,
  });
  const bytes = new TextEncoder().encode(canonicalTargetJson(canonical));
  if (bytes.length > MAX_GITHUB_DEEP_LINK_TARGET_BYTES) {
    throw new GitHubTargetDeepLinkError('target-too-large', 'GitHub deep-link target is too large.');
  }
  return encodeBase64Url(bytes);
}

export function decodeGitHubSourceTarget(value: string): GitHubSourceTarget {
  const bytes = decodeBase64Url(value);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target is not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new GitHubTargetDeepLinkError('invalid-target', 'GitHub deep-link target is not valid JSON.');
  }
  return canonicalTarget(parsed);
}

export function buildGitHubTargetDeepLinkParams(target: GitHubSourceTarget): string {
  const params = new URLSearchParams();
  params.set('targetVersion', '1');
  params.set('target', encodeGitHubSourceTarget(target));
  return params.toString();
}

export function decodeGitHubTargetDeepLinkParams(
  value: string | URLSearchParams
): GitHubSourceTarget {
  const params =
    typeof value === 'string'
      ? new URLSearchParams(value.startsWith('?') ? value.slice(1) : value)
      : value;
  const versions = params.getAll('targetVersion');
  const targets = params.getAll('target');
  if (versions.length !== 1 || versions[0] !== '1') {
    throw new GitHubTargetDeepLinkError(
      'invalid-version',
      'GitHub deep-link targetVersion must be exactly 1.'
    );
  }
  if (targets.length !== 1) {
    throw new GitHubTargetDeepLinkError(
      'invalid-target',
      'GitHub deep link must contain exactly one target.'
    );
  }
  return decodeGitHubSourceTarget(targets[0]);
}