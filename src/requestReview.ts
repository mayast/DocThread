import type { SourceTarget } from './source.ts';
import type { GitHubTarget } from './types.ts';
import { githubBlobUrl } from './source.ts';

export type ReviewRequestChannel = 'github-issue' | 'github-pr' | 'azure-repos-pr' | 'ado-work-item';

export type ReviewRequestStatus =
  | 'draft'
  | 'requested'
  | 'in_progress'
  | 'changes_requested'
  | 'approved'
  | 'closed'
  | 'canceled'
  | 'stale'
  | 'unknown';

export interface RequestReviewChannelEligibility {
  channel: ReviewRequestChannel;
  label: string;
  artifact: string;
  provider: string;
  available: boolean;
  missing: string[];
  gatedReason?: string;
}

export interface ReviewRequestDraft {
  channel: ReviewRequestChannel;
  title: string;
  scope: string;
  instructions: string;
  reviewersText: string;
  targetBranch: string;
  createdAt: string;
}

export interface ReviewRequestRecord {
  id: string;
  sourceKey: string;
  channel: ReviewRequestChannel;
  status: ReviewRequestStatus;
  providerState: string;
  title: string;
  scope: string;
  instructions: string;
  requestedReviewers: string[];
  confirmedAssignees?: string[];
  hidden?: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  externalId?: string;
  externalNumber?: number;
  externalUrl?: string;
  duplicateKey: string;
  createdAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  closedReason?: string;
  assignmentWarning?: string;
  staleReason?: string;
}

export interface RequestReviewPreview {
  sourceKey: string;
  provider: string;
  repository: string;
  sourceBranch: string;
  targetBranch?: string;
  document: string;
  sourceLink: string;
  docThreadLink: string;
  title: string;
  scope: string;
  instructions: string;
  body: string;
  reviewers: string[];
  duplicate?: ReviewRequestRecord;
  duplicateKey: string;
  reviewerErrors: string[];
}

type RequestReviewStorage = Pick<Storage, 'getItem' | 'setItem'>;

const ACTIVE_STATUSES = new Set<ReviewRequestStatus>([
  'requested',
  'in_progress',
  'changes_requested',
  'stale',
  'unknown',
]);
export function requestReviewStorageKey(sourceKey: string): string {
  return `docthread:request-review:${sourceKey}`;
}

export function requestReviewDraftStorageKey(sourceKey: string): string {
  return `docthread:request-review-draft:${sourceKey}`;
}

function clean(value: string): string {
  return value.trim();
}

function splitReviewers(value: string): string[] {
  const seen = new Set<string>();
  const reviewers: string[] = [];
  for (const reviewer of value.split(/[,\s]+/).map((entry) => entry.trim().replace(/^@/, '')).filter(Boolean)) {
    const key = reviewer.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      reviewers.push(reviewer);
    }
  }
  return reviewers;
}

export function parseReviewerHandles(value: string): string[] {
  return splitReviewers(value);
}

export function defaultRequestReviewDraft(
  target: SourceTarget | null,
  documentTitle: string | undefined,
  nowIso: string
): ReviewRequestDraft {
  return {
    channel: 'github-issue',
    title: `Review ${documentTitle || (target ? sourceDocumentLabel(target) : 'document')}`,
    scope: 'Entire document',
    instructions: 'Please review this document and leave feedback in DocThread.',
    reviewersText: '',
    targetBranch: '',
    createdAt: nowIso,
  };
}

export function normalizeRequestReviewDraftChannel(value: unknown): ReviewRequestChannel {
  if (value === 'azure-repos-pr' || value === 'ado-work-item') return value;
  return 'github-issue';
}

export function defaultTargetBranch(sourceBranch: string | null | undefined): string {
  if (!sourceBranch) return 'main';
  return sourceBranch === 'main' ? 'develop' : 'main';
}

function sourceDocumentLabel(target: SourceTarget): string {
  return target.kind === 'ado-workitem' ? `#${target.id}` : target.path;
}

function sourceProviderName(target: SourceTarget): string {
  if (target.kind === 'github') return 'GitHub';
  return target.kind === 'azure-repos' ? 'Azure Repos' : 'ADO work item';
}

function sourceReferenceLabel(target: SourceTarget): string {
  return target.kind === 'ado-workitem' ? `work item #${target.id}` : target.ref || 'default branch';
}

function sourceRepositoryLabel(target: SourceTarget): string {
  if (target.kind === 'github') return `${target.owner}/${target.repo}`;
  if (target.kind === 'azure-repos') return `${target.organization}/${target.project}/${target.repo}`;
  return `${target.organization}/${target.project ?? '-'}`;
}

function sourceFileUrl(target: SourceTarget): string {
  if (target.kind === 'github') return githubBlobUrl(target);
  if (target.kind === 'azure-repos') {
    const versionPrefix = target.versionType === 'branch' ? 'GB' : target.versionType === 'tag' ? 'GT' : 'GC';
    const version = target.ref ? `&version=${encodeURIComponent(versionPrefix + target.ref)}` : '';
    return `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(
      target.project
    )}/_git/${encodeURIComponent(target.repo)}?path=/${encodeURIComponent(target.path)}${version}`;
  }
  return `https://dev.azure.com/${encodeURIComponent(target.organization)}/${encodeURIComponent(
    target.project || ''
  )}/_workitems/edit/${target.id}`;
}

export function requestReviewEligibility(
  target: SourceTarget | null,
  signedIn: { github: boolean; azure: boolean }
): RequestReviewChannelEligibility[] {
  const githubMissing: string[] = [];
  if (!target) githubMissing.push('Open a repository-backed document.');
  else if (target.kind !== 'github') githubMissing.push('Open a GitHub-backed document.');
  if (!signedIn.github) githubMissing.push('Sign in with GitHub.');

  return [
    {
      channel: 'github-issue',
      label: 'GitHub review issue',
      artifact: 'Issue',
      provider: target?.kind === 'github' ? sourceRepositoryLabel(target) : 'GitHub',
      available: githubMissing.length === 0,
      missing: githubMissing,
    },
    {
      channel: 'azure-repos-pr',
      label: 'Azure Repos pull request',
      artifact: 'Pull request',
      provider: target?.kind === 'azure-repos' ? sourceRepositoryLabel(target) : 'Azure Repos',
      available: false,
      missing: ['Planned for Phase 2.'],
      gatedReason: 'Visible but gated until the Phase 2 Azure DevOps pilot.',
    },
    {
      channel: 'ado-work-item',
      label: 'Azure Boards review item',
      artifact: 'Child work item',
      provider: target && target.kind !== 'github' ? sourceProviderName(target) : 'Azure Boards',
      available: false,
      missing: ['Planned for Phase 2.'],
      gatedReason: 'Visible but gated until Phase 2 parent selection and process validation ship.',
    },
  ];
}

function utf8Bytes(value: string): number[] {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return bytes;
}

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) {
    bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    for (let index = 0; index < hash.length; index += 1) {
      hash[index] = (hash[index] + [a, b, c, d, e, f, g, h][index]) >>> 0;
    }
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function legacyGitHubIssueDuplicateKey(target: Pick<GitHubTarget, 'owner' | 'repo' | 'path'>): string {
  const input = `github-issue\n${target.owner.toLocaleLowerCase()}/${target.repo.toLocaleLowerCase()}\n${target.path}`;
  return `github-issue:${sha256Hex(input)}`;
}

export function githubIssueDuplicateKey(target: GitHubTarget): string {
  const input = JSON.stringify([
    'github-issue-v2', target.owner.toLowerCase(), target.repo.toLowerCase(),
    target.path, target.versionType ?? 'branch', target.ref,
  ]);
  return `github-issue:v2:${sha256Hex(input)}`;
}

export function githubReviewDuplicateKey(sourceKey: string, targetBranch: string): string {
  return ['github-pr', sourceKey, targetBranch.trim().toLocaleLowerCase()].join('|');
}

export function findActiveDuplicate(
  records: readonly ReviewRequestRecord[],
  sourceKey: string,
  channel: ReviewRequestChannel,
  targetOrParent: string
): ReviewRequestRecord | undefined {
  const key =
    channel === 'github-pr'
      ? githubReviewDuplicateKey(sourceKey, targetOrParent)
      : [channel, sourceKey, targetOrParent.trim().toLocaleLowerCase()].join('|');
  return records.find((record) => record.duplicateKey === key && ACTIVE_STATUSES.has(record.status));
}

export function findActiveGitHubIssueDuplicate(
  records: readonly ReviewRequestRecord[],
  target: GitHubTarget
): ReviewRequestRecord | undefined {
  const key = githubIssueDuplicateKey(target);
  const legacyKey = legacyGitHubIssueDuplicateKey(target);
  return records.find((record) => record.channel === 'github-issue' &&
    (record.duplicateKey === key || record.duplicateKey === legacyKey) &&
    record.providerState !== 'closed');
}

export function reviewerHandleErrors(reviewers: readonly string[]): string[] {
  const errors: string[] = [];
  const handleRe = /^(?![-_])(?!.*--)[A-Za-z0-9_-]{1,39}(?<![-_])$/;
  for (const reviewer of reviewers) {
    if (reviewer.includes('/')) {
      errors.push(`GitHub teams are not supported as issue reviewers: ${reviewer}.`);
    } else if (!handleRe.test(reviewer)) {
      errors.push(`Invalid GitHub user handle: ${reviewer}.`);
    }
  }
  return errors;
}

export function buildGitHubReviewBody(input: {
  scope: string;
  instructions: string;
  docThreadLink: string;
  sourceLink: string;
  reviewers: readonly string[];
  duplicateKey: string;
}): string {
  return [
    'Requested via **DocThread**.',
    '',
    `DocThread review: ${input.docThreadLink}`,
    `Source document: ${input.sourceLink}`,
    '',
    `Requested reviewers: ${input.reviewers.map((reviewer) => `@${reviewer}`).join(' ') || 'None'}`,
    '',
    '## Review scope',
    input.scope.trim(),
    '',
    '## Instructions',
    input.instructions.trim(),
    '',
    `<!-- docthread-review-key:${input.duplicateKey} -->`,
  ].join('\n');
}

export function buildGitHubRequestPreview(input: {
  target: Extract<SourceTarget, { kind: 'github' }>;
  sourceKey: string;
  draft: ReviewRequestDraft;
  records: readonly ReviewRequestRecord[];
  appUrl: string;
  docThreadLink: string;
}): RequestReviewPreview {
  const duplicateKey = githubIssueDuplicateKey(input.target);
  const reviewers = parseReviewerHandles(input.draft.reviewersText);
  const scope = clean(input.draft.scope);
  const instructions = clean(input.draft.instructions);
  return {
    sourceKey: input.sourceKey,
    provider: 'GitHub',
    repository: sourceRepositoryLabel(input.target),
    sourceBranch: sourceReferenceLabel(input.target),
    document: sourceDocumentLabel(input.target),
    sourceLink: sourceFileUrl(input.target),
    docThreadLink: input.docThreadLink,
    title: clean(input.draft.title),
    scope,
    instructions,
    body: buildGitHubReviewBody({
      scope,
      instructions,
      docThreadLink: input.docThreadLink,
      sourceLink: sourceFileUrl(input.target),
      reviewers,
      duplicateKey,
    }),
    reviewers,
    duplicate: findActiveGitHubIssueDuplicate(input.records, input.target),
    duplicateKey,
    reviewerErrors: reviewerHandleErrors(reviewers),
  };
}

export function validateGitHubRequestPreview(preview: RequestReviewPreview): string[] {
  const errors: string[] = [];
  if (!preview.title) errors.push('Enter a title.');
  if (!preview.scope) errors.push('Enter a review scope.');
  if (!preview.body.includes('## Instructions') || /## Instructions\n\s*$/.test(preview.body)) {
    errors.push('Enter review instructions.');
  }
  if (preview.reviewers.length === 0) errors.push('Select at least one GitHub reviewer.');
  errors.push(...preview.reviewerErrors);
  return errors;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseRecord(value: unknown): ReviewRequestRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ReviewRequestRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.sourceKey !== 'string' ||
    typeof record.channel !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.providerState !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.scope !== 'string' ||
    typeof record.instructions !== 'string' ||
    typeof record.duplicateKey !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  if (!['github-issue', 'github-pr', 'azure-repos-pr', 'ado-work-item'].includes(record.channel)) return null;
  if (!['draft', 'requested', 'in_progress', 'changes_requested', 'approved', 'closed', 'canceled', 'stale', 'unknown'].includes(record.status)) return null;
  return {
    id: record.id,
    sourceKey: record.sourceKey,
    channel: record.channel as ReviewRequestChannel,
    status: record.channel === 'github-issue' && record.status === 'canceled'
      ? record.providerState === 'closed' ? 'closed' : record.providerState === 'open' ? 'stale' : 'unknown'
      : record.status as ReviewRequestStatus,
    providerState: record.providerState,
    title: record.title,
    scope: record.scope,
    instructions: record.instructions,
    requestedReviewers: asStringArray(record.requestedReviewers),
    ...(Array.isArray(record.confirmedAssignees) ? { confirmedAssignees: asStringArray(record.confirmedAssignees) } : {}),
    ...(typeof record.hidden === 'boolean' || record.status === 'canceled'
      ? { hidden: record.hidden ?? true } : {}),
    duplicateKey: record.duplicateKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.sourceBranch === 'string' ? { sourceBranch: record.sourceBranch } : {}),
    ...(typeof record.targetBranch === 'string' ? { targetBranch: record.targetBranch } : {}),
    ...(typeof record.externalId === 'string' ? { externalId: record.externalId } : {}),
    ...(typeof record.externalNumber === 'number' && Number.isSafeInteger(record.externalNumber) ? { externalNumber: record.externalNumber } : {}),
    ...(typeof record.externalUrl === 'string' ? { externalUrl: record.externalUrl } : {}),
    ...(typeof record.lastRefreshAt === 'string' ? { lastRefreshAt: record.lastRefreshAt } : {}),
    ...(typeof record.closedReason === 'string' ? { closedReason: record.closedReason } : {}),
    ...(typeof record.assignmentWarning === 'string' ? { assignmentWarning: record.assignmentWarning } : {}),
    ...(typeof record.staleReason === 'string' ? { staleReason: record.staleReason } : {}),
  };
}

export function parseReviewRequestRecords(raw: string | null): ReviewRequestRecord[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseRecord).filter((record): record is ReviewRequestRecord => Boolean(record));
}

export function loadReviewRequestRecords(storage: RequestReviewStorage, sourceKey: string): ReviewRequestRecord[] {
  return parseReviewRequestRecords(storage.getItem(requestReviewStorageKey(sourceKey)))
    .filter(record => record.sourceKey === sourceKey);
}

export function storeReviewRequestRecords(
  storage: RequestReviewStorage,
  sourceKey: string,
  records: readonly ReviewRequestRecord[]
): void {
  if (records.some(record => record.sourceKey !== sourceKey)) throw new Error('Review request source mismatch.');
  storage.setItem(requestReviewStorageKey(sourceKey), JSON.stringify(records, null, 2));
}

export function mergeReviewRequestRecords(
  sourceKey: string,
  stored: readonly ReviewRequestRecord[],
  memory: readonly ReviewRequestRecord[]
): ReviewRequestRecord[] {
  const result = new Map<string, ReviewRequestRecord>();
  for (const record of [...stored, ...memory]) {
    if (record.sourceKey !== sourceKey) continue;
    const previous = result.get(record.id);
    if (!previous || record.updatedAt >= previous.updatedAt) result.set(record.id, record);
  }
  return [...result.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function upsertReviewRequestRecord(
  records: readonly ReviewRequestRecord[],
  record: ReviewRequestRecord
): ReviewRequestRecord[] {
  const without = records.filter((entry) => entry.id !== record.id);
  return [record, ...without].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function makeGitHubReviewRecord(input: {
  id: string;
  sourceKey: string;
  sourceBranch: string;
  preview: RequestReviewPreview;
  externalId: string;
  externalNumber: number;
  externalUrl: string;
  providerState?: string;
  assignmentWarning?: string;
  confirmedAssignees?: string[];
  nowIso: string;
}): ReviewRequestRecord {
  return {
    id: input.id,
    sourceKey: input.sourceKey,
    channel: 'github-issue',
    status: mapGitHubIssueStatus(input.providerState || 'open'),
    providerState: input.providerState || 'open',
    title: input.preview.title,
    scope: input.preview.scope,
    instructions: input.preview.instructions,
    requestedReviewers: input.preview.reviewers,
    ...(input.confirmedAssignees ? { confirmedAssignees: input.confirmedAssignees } : {}),
    sourceBranch: input.sourceBranch,
    externalId: input.externalId,
    externalNumber: input.externalNumber,
    externalUrl: input.externalUrl,
    duplicateKey: input.preview.duplicateKey,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    lastRefreshAt: input.nowIso,
    ...(input.assignmentWarning ? { assignmentWarning: input.assignmentWarning } : {}),
  };
}

export function makeUnknownGitHubIssueRecord(input: {
  id: string;
  sourceKey: string;
  sourceBranch: string;
  preview: RequestReviewPreview;
  nowIso: string;
  staleReason?: string;
}): ReviewRequestRecord {
  return {
    id: input.id,
    sourceKey: input.sourceKey,
    channel: 'github-issue',
    status: 'unknown',
    providerState: 'unknown',
    title: input.preview.title,
    scope: input.preview.scope,
    instructions: input.preview.instructions,
    requestedReviewers: input.preview.reviewers,
    sourceBranch: input.sourceBranch,
    duplicateKey: input.preview.duplicateKey,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    ...(input.staleReason ? { staleReason: input.staleReason } : {}),
  };
}

export interface GitHubReviewPullRequestInput {
  title: string;
  body: string;
  targetBranch: string;
  reviewers: string[];
}

export interface GitHubReviewPullRequestResult {
  url: string;
  number: number;
  id: string;
  state: string;
  duplicate: boolean;
  reviewerRequestError?: string;
}

export interface GitHubReviewIssueInput {
  title: string;
  body: string;
  reviewers: string[];
  isCurrent?: () => boolean;
}

export interface GitHubReviewIssueResult {
  url: string;
  number: number;
  id: string;
  state: 'open' | 'closed';
  confirmedAssignees?: string[];
  reviewerAssignmentWarning?: string;
  duplicate?: boolean;
}

export type RequestReviewFailureCategory =
  | 'signed-out'
  | 'issues-disabled'
  | 'permission-denied'
  | 'invalid-assignee'
  | 'provider-validation'
  | 'rate-limited'
  | 'network-provider-unavailable'
  | 'unknown-outcome';

export class RequestReviewProviderError extends Error {
  readonly category: RequestReviewFailureCategory;

  constructor(category: RequestReviewFailureCategory, message: string) {
    super(message);
    this.name = 'RequestReviewProviderError';
    this.category = category;
  }
}

interface GitHubPullResponse {
  id?: number;
  number?: number;
  html_url?: string;
  state?: string;
}

interface GitHubIssueResponse {
  id?: number;
  number?: number;
  html_url?: string;
  state?: string;
  body?: string;
  assignees?: Array<{ login?: unknown }>;
  pull_request?: unknown;
}

function githubRestUrl(apiBase: string, requestPath: string): string {
  return `${apiBase.replace(/\/+$/, '')}${requestPath}`;
}

async function githubRestRequest<T>(
  fetchImpl: typeof fetch,
  apiBase: string,
  requestPath: string,
  init: RequestInit,
  token: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(githubRestUrl(apiBase, requestPath), {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new RequestReviewProviderError(
      init.method === 'POST' ? 'unknown-outcome' : 'network-provider-unavailable',
      error instanceof Error ? error.message : 'GitHub is unavailable.'
    );
  }
  const creatingIssue = init.method === 'POST' && /\/issues$/.test(requestPath);
  let payload: { message?: string; errors?: Array<{ resource?: string; field?: string; code?: string }> };
  try {
    payload = await response.json();
  } catch {
    throw new RequestReviewProviderError(
      creatingIssue && (response.ok || response.status >= 500) ? 'unknown-outcome' : 'network-provider-unavailable',
      `GitHub returned an unreadable response (${response.status}).`
    );
  }
  if (!response.ok) {
    const message = payload?.message || `GitHub request failed (${response.status}).`;
    const assigneeOnly = response.status === 422 && Array.isArray(payload?.errors) && payload.errors.length > 0 &&
      payload.errors.every(error => error.resource === 'Issue' && error.field === 'assignees' && error.code === 'invalid');
    throw new RequestReviewProviderError(
      creatingIssue && response.status >= 500 ? 'unknown-outcome' :
        assigneeOnly ? 'invalid-assignee' : mapGitHubStatus(response.status, message), message
    );
  }
  return payload as T;
}

function mapGitHubStatus(status: number, message: string): RequestReviewFailureCategory {
  if (status === 401) return 'signed-out';
  if (status === 403 && /rate limit/i.test(message)) return 'rate-limited';
  if (status === 403) return 'permission-denied';
  if (status === 404 || status === 410) return 'issues-disabled';
  if (status === 422) return 'provider-validation';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'network-provider-unavailable';
  return 'provider-validation';
}

function requirePullResponse(pull: GitHubPullResponse, context: string): GitHubReviewPullRequestResult {
  if (!pull.html_url || typeof pull.number !== 'number') {
    throw new Error(`${context} did not return a pull request identifier.`);
  }
  return {
    url: pull.html_url,
    number: pull.number,
    id: String(pull.id ?? pull.number),
    state: pull.state || 'open',
    duplicate: context === 'Existing GitHub pull request',
  };
}

function requireIssueResponse(issue: GitHubIssueResponse, context: string): GitHubReviewIssueResult {
  const category = context === 'Created GitHub issue' ? 'unknown-outcome' : 'provider-validation';
  if (issue?.pull_request) {
    throw new RequestReviewProviderError(category, `${context} returned a pull request, not an issue.`);
  }
  if (!issue?.html_url || !Number.isSafeInteger(issue.number) || issue.number! <= 0 ||
    !['open', 'closed'].includes(issue.state ?? '')) {
    throw new RequestReviewProviderError(category, `${context} did not return an issue identifier and state.`);
  }
  const state = issue.state === 'closed' ? 'closed' : 'open';
  return {
    url: issue.html_url,
    number: issue.number!,
    id: String(issue.id ?? issue.number),
    state,
    ...(Array.isArray(issue.assignees) ? { confirmedAssignees: assigneeLogins(issue) } : {}),
  };
}

function assigneeLogins(issue: GitHubIssueResponse): string[] {
  return (Array.isArray(issue.assignees) ? issue.assignees : [])
    .flatMap(assignee => typeof assignee?.login === 'string' ? [assignee.login] : []);
}

function assignmentResult(confirmedAssignees: string[] | undefined, reviewers: readonly string[]) {
  const missing = missingAssignees(confirmedAssignees, reviewers);
  return {
    confirmedAssignees,
    reviewerAssignmentWarning: missing.length > 0
      ? `GitHub did not confirm these assignees: ${missing.map(reviewer => `@${reviewer}`).join(', ')}.` : undefined,
  };
}

function requireIssueWrite(token: string, isCurrent?: () => boolean): void {
  // Dev-CLI auth is server-side; the caller supplies the current authenticated scope.
  if (!token && !isCurrent) throw new RequestReviewProviderError('signed-out', 'Sign in with GitHub.');
  if (isCurrent && !isCurrent()) throw new RequestReviewProviderError('provider-validation', 'Source or account changed. Preview again.');
}

function missingAssignees(assignees: readonly string[] | undefined, reviewers: readonly string[]): string[] {
  if (reviewers.length === 0) return [];
  const assigned = new Set((assignees ?? []).map(login => login.toLocaleLowerCase()));
  return reviewers.filter((reviewer) => !assigned.has(reviewer.toLocaleLowerCase()));
}

export async function createGitHubReviewIssue(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  target: GitHubTarget,
  input: GitHubReviewIssueInput
): Promise<GitHubReviewIssueResult> {
  requireIssueWrite(token, input.isCurrent);
  const existing = await discoverActiveGitHubReviewIssue(fetchImpl, apiBase, token, target);
  requireIssueWrite(token, input.isCurrent);
  if (existing) return existing;
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const repositoryPath = `/repos/${owner}/${repo}`;
  const createIssue = (includeAssignees: boolean) => {
    requireIssueWrite(token, input.isCurrent);
    return githubRestRequest<GitHubIssueResponse>(
      fetchImpl,
      apiBase,
      `${repositoryPath}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          ...(includeAssignees && input.reviewers.length > 0 ? { assignees: input.reviewers } : {}),
        }),
      },
      token
    );
  };

  let created: GitHubIssueResponse;
  let reviewerAssignmentWarning: string | undefined;
  try {
    created = await createIssue(true);
  } catch (error) {
    if (!(error instanceof RequestReviewProviderError) || error.category !== 'invalid-assignee' || input.reviewers.length === 0) {
      throw error;
    }
    reviewerAssignmentWarning = error.message;
    created = await createIssue(false);
  }
  let result = requireIssueResponse(created, 'Created GitHub issue');
  const reviewersMissingFromIssue = missingAssignees(result.confirmedAssignees, input.reviewers);
  if (reviewersMissingFromIssue.length > 0) {
    try {
      const assignment = await assignGitHubReviewIssueReviewers(
        fetchImpl, apiBase, token, target, result.number, reviewersMissingFromIssue, input.isCurrent
      );
      result = { ...result, confirmedAssignees: assignment.confirmedAssignees };
      reviewerAssignmentWarning = assignmentResult(assignment.confirmedAssignees, input.reviewers).reviewerAssignmentWarning;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub did not accept one or more issue assignees.';
      reviewerAssignmentWarning = reviewerAssignmentWarning ? `${reviewerAssignmentWarning} ${message}` : message;
    }
  }

  return reviewerAssignmentWarning ? { ...result, reviewerAssignmentWarning } : result;
}

export async function assignGitHubReviewIssueReviewers(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  target: GitHubTarget,
  issueNumber: number,
  reviewers: readonly string[],
  isCurrent?: () => boolean
): Promise<{ confirmedAssignees?: string[]; reviewerAssignmentWarning?: string }> {
  requireIssueWrite(token, isCurrent);
  if (reviewers.length === 0) return {};
  const response = await githubRestRequest<{ assignees?: Array<{ login?: unknown }> }>(
    fetchImpl,
    apiBase,
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${issueNumber}/assignees`,
    {
      method: 'POST',
      body: JSON.stringify({ assignees: reviewers }),
    },
    token
  );
  return assignmentResult(Array.isArray(response?.assignees) ? assigneeLogins(response) : undefined, reviewers);
}

async function discoverGitHubReviewIssue(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  target: GitHubTarget,
  state: 'open' | 'all',
  duplicateKey = githubIssueDuplicateKey(target)
): Promise<GitHubReviewIssueResult | null> {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const marker = `<!-- docthread-review-key:${duplicateKey} -->`;
  const legacyMarker = `<!-- docthread-review-key:${legacyGitHubIssueDuplicateKey(target)} -->`;
  if (duplicateKey !== githubIssueDuplicateKey(target)) {
    throw new RequestReviewProviderError('provider-validation', 'Legacy unknown request needs manual resolution in GitHub; its marker did not identify a ref.');
  }
  const matches = new Map<number, GitHubIssueResponse>();
  let complete = false;
  for (let page = 1; page <= 5; page += 1) {
    const issues = await githubRestRequest<GitHubIssueResponse[]>(
      fetchImpl,
      apiBase,
      `/repos/${owner}/${repo}/issues?state=${state}&sort=created&direction=desc&per_page=100&page=${page}`,
      {},
      token
    );
    if (!Array.isArray(issues)) throw new RequestReviewProviderError('provider-validation', 'GitHub issue discovery returned an invalid page.');
    for (const issue of issues) {
      if (issue.pull_request || typeof issue.body !== 'string') continue;
      if (issue.body.includes(legacyMarker)) {
        throw new RequestReviewProviderError('provider-validation', `Legacy DocThread issue #${issue.number} needs manual resolution: its marker does not identify branch versus tag.`);
      }
      if (issue.body.includes(marker)) {
        const verified = requireIssueResponse(issue, 'Discovered GitHub issue');
        if (state === 'all' || verified.state === 'open') matches.set(verified.number, issue);
      }
    }
    if (issues.length < 100) { complete = true; break; }
  }
  if (!complete) {
    throw new RequestReviewProviderError('provider-validation', 'GitHub issue discovery is incomplete after 500 repository issue/PR entries. Resolve manually in GitHub; no new issue was created.');
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) {
    throw new RequestReviewProviderError(
      'provider-validation',
      `Multiple GitHub issues match this DocThread review key: ${[...matches.keys()].map(number => `#${number}`).join(', ')}.`
    );
  }
  return { ...requireIssueResponse([...matches.values()][0], 'Reconciled GitHub issue'), duplicate: true };
}

export function discoverActiveGitHubReviewIssue(
  fetchImpl: typeof fetch, apiBase: string, token: string, target: GitHubTarget
): Promise<GitHubReviewIssueResult | null> {
  return discoverGitHubReviewIssue(fetchImpl, apiBase, token, target, 'open');
}

export function reconcileUnknownGitHubReviewIssue(
  fetchImpl: typeof fetch, apiBase: string, token: string, target: GitHubTarget,
  _authenticatedLogin: string, duplicateKey: string
): Promise<GitHubReviewIssueResult | null> {
  return discoverGitHubReviewIssue(fetchImpl, apiBase, token, target, 'all', duplicateKey);
}

export function mapGitHubIssueStatus(state: string): ReviewRequestStatus {
  return state === 'closed' ? 'closed' : 'requested';
}

export async function refreshGitHubReviewIssueStatus(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  target: GitHubTarget,
  issueNumber: number
): Promise<GitHubReviewIssueResult> {
  const issue = await githubRestRequest<GitHubIssueResponse>(
    fetchImpl,
    apiBase,
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${issueNumber}`,
    {},
    token
  );
  return requireIssueResponse(issue, 'GitHub issue status');
}

export async function createGitHubReviewPullRequest(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  target: GitHubTarget,
  input: GitHubReviewPullRequestInput
): Promise<GitHubReviewPullRequestResult> {
  if (target.versionType && target.versionType !== 'branch') {
    throw new Error('Request review requires a remotely available GitHub source branch.');
  }
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const head = encodeURIComponent(target.ref);
  const base = encodeURIComponent(input.targetBranch);
  const repositoryPath = `/repos/${owner}/${repo}`;

  await githubRestRequest(fetchImpl, apiBase, `${repositoryPath}/branches/${head}`, {}, token);
  await githubRestRequest(fetchImpl, apiBase, `${repositoryPath}/branches/${base}`, {}, token);

  const existing = await githubRestRequest<GitHubPullResponse[]>(
    fetchImpl,
    apiBase,
    `${repositoryPath}/pulls?state=open&head=${owner}:${head}&base=${base}&per_page=10`,
    {},
    token
  );
  const duplicate = existing.find((pull) => pull.html_url && typeof pull.number === 'number');
  if (duplicate) return requirePullResponse(duplicate, 'Existing GitHub pull request');

  const comparison = await githubRestRequest<{ ahead_by?: number; status?: string }>(
    fetchImpl,
    apiBase,
    `${repositoryPath}/compare/${base}...${head}`,
    {},
    token
  );
  if ((comparison.ahead_by ?? 0) <= 0 || comparison.status === 'identical') {
    throw new Error('The source branch has no reviewable difference from the target branch.');
  }

  const created = await githubRestRequest<GitHubPullResponse>(
    fetchImpl,
    apiBase,
    `${repositoryPath}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: target.ref,
        base: input.targetBranch,
        maintainer_can_modify: false,
      }),
    },
    token
  );
  const result = requirePullResponse(created, 'Created GitHub pull request');

  if (input.reviewers.length > 0) {
    try {
      await githubRestRequest(
        fetchImpl,
        apiBase,
        `${repositoryPath}/pulls/${result.number}/requested_reviewers`,
        {
          method: 'POST',
          body: JSON.stringify({ reviewers: input.reviewers }),
        },
        token
      );
    } catch (error) {
      return {
        ...result,
        reviewerRequestError:
          error instanceof Error ? error.message : 'GitHub did not accept the reviewer request.',
      };
    }
  }
  return result;
}

export function formatReviewRequestStatus(record: ReviewRequestRecord): string {
  if (record.channel === 'github-issue') {
    if (record.status === 'unknown') return 'Pending confirmation';
    if (record.status === 'stale') return `${record.providerState === 'closed' ? 'Closed' : record.providerState === 'open' ? 'Open' : 'Unknown'} (last confirmed)`;
    return record.providerState === 'closed' ? 'Closed' : record.providerState === 'open' ? 'Open' : 'Pending confirmation';
  }
  if (record.status === 'requested') return 'Review requested';
  if (record.status === 'in_progress') return 'In progress';
  if (record.status === 'changes_requested') return 'Changes requested';
  if (record.status === 'approved') return 'Approved';
  if (record.status === 'closed') return 'Closed';
  if (record.status === 'canceled') return 'Canceled';
  if (record.status === 'stale') return 'Stale';
  return 'Unknown';
}
