import type {
  DocThreadFile,
  DocThreadFileV1,
  DocThreadFileV2,
  GitHubTarget,
  PersistedRepositoryIdentity,
} from './types';
import { localStorageKeyV2, sidecarPath, type SourceTarget } from './source';
import { createAdoWorkItemClient, workItemUrl, type AdoReviewStoreMode } from './ado';
import { createAzureReposClient } from './azureRepos';
import { ADO_TRANSPORT, getAzureReposAccessToken } from './azureAuth';
import { decodeDocThreadFile } from './reviewSchema';
import { mergeDocThreadFiles, sanitizeLegacyThreadsForMigration } from './reviewPersistence';
import { buildGitHubTargetDeepLinkParams } from './githubSource';
import { withThreadParam } from './threadLink';
import {
  commitDocToGitHub,
  createDocEditPR,
  docBlobUrl,
  fetchMarkdown,
  loadSidecarsFromGitHub,
  saveSidecarToGitHubAtomic,
} from './github';

export interface LoadedSourceDocument {
  text: string;
  revision: string | null;
}

export interface LoadedSourceSidecar {
  file: DocThreadFileV2 | null;
  revision: string | null;
  hasV2: boolean;
}

export interface SourcePullRequest {
  url: string;
  branch: string;
  number: number;
}

const azureRepos = createAzureReposClient({
  baseUrl:
    ADO_TRANSPORT === 'dev-cli' && typeof window !== 'undefined'
      ? `${window.location.origin}/ado-api`
      : 'https://dev.azure.com',
  getAccessToken: getAzureReposAccessToken,
});

const adoWorkItems = createAdoWorkItemClient({
  baseUrl:
    ADO_TRANSPORT === 'dev-cli' && typeof window !== 'undefined'
      ? `${window.location.origin}/ado-api`
      : 'https://dev.azure.com',
  getAccessToken: getAzureReposAccessToken,
});

// Where ADO work-item reviews are stored (replaces the shared git store). The
// choice is user-selectable in the UI; App persists it and pushes it here.
let adoReviewStoreMode: AdoReviewStoreMode = 'attachment';
export function getAdoReviewStoreMode(): AdoReviewStoreMode {
  return adoReviewStoreMode;
}
export function setAdoReviewStoreMode(mode: AdoReviewStoreMode): void {
  adoReviewStoreMode = mode;
}

function githubTarget(target: SourceTarget): GitHubTarget {
  if (target.kind !== 'github') throw new Error('Expected a GitHub source target.');
  return target;
}

export async function fetchSourceDocument(
  target: SourceTarget,
  expectedRevision?: string | null
): Promise<LoadedSourceDocument> {
  if (target.kind === 'ado-workitem') return adoWorkItems.fetchDocument(target);
  if (target.kind === 'azure-repos') return azureRepos.fetchMarkdown(target, expectedRevision);
  const result = await fetchMarkdown('', githubTarget(target));
  return { text: result.text, revision: result.sha };
}

export async function resolveSourceTarget(target: SourceTarget): Promise<SourceTarget> {
  if (target.kind === 'azure-repos') return azureRepos.resolveTarget(target);
  if (target.kind === 'ado-workitem') return adoWorkItems.resolveTarget(target);
  return target;
}

export async function loadSourceSidecar(target: SourceTarget): Promise<LoadedSourceSidecar> {
  if (target.kind === 'ado-workitem') return { file: null, revision: null, hasV2: false };
  const raw =
    target.kind === 'azure-repos'
      ? await azureRepos.loadSidecar(target)
      : await loadSidecarsFromGitHub('', githubTarget(target));
  return decodeRepositorySidecars(target, raw);
}

/**
 * ADO work-item reviews live with the work item (attachment / description /
 * discussion), not in the repo v2 sidecar pipeline. These dedicated helpers keep
 * that snapshot store separate from the identity-gated repository machinery.
 */
export async function loadAdoReview(
  target: Extract<SourceTarget, { kind: 'ado-workitem' }>
): Promise<DocThreadFileV1 | null> {
  return adoWorkItems.readReview(target, adoReviewStoreMode);
}

export async function saveAdoReview(
  target: Extract<SourceTarget, { kind: 'ado-workitem' }>,
  file: DocThreadFileV1
): Promise<void> {
  if (file.schemaVersion !== 1) {
    throw new Error('ADO work-item reviews use a schema-v1 snapshot payload.');
  }
  await adoWorkItems.saveReview(target, adoReviewStoreMode, file);
}

const saveQueues = new Map<string, Promise<void>>();
// The SHA our last successful GitHub sidecar save advanced the branch to, per
// document. GitHub's git/refs read lags behind our own just-written commits, so
// re-reading the tip between serialized saves yields a stale parent and a
// non-fast-forward (422) storm. Using our own last-written tip as the base for
// the next serialized save avoids the lag entirely; a genuine external advance
// still 422s and is recovered by saveSidecarToGitHubAtomic's re-read self-heal.
const githubSidecarTip = new Map<string, string>();

export function saveSourceSidecar(
  target: SourceTarget,
  file: DocThreadFile,
  _revision: string | null
): Promise<LoadedSourceSidecar> {
  const queueKey = sourceStorageKey(target);
  const previous = saveQueues.get(queueKey) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => saveSourceSidecarNow(target, file, _revision));
  const settled = operation.then(
    () => undefined,
    () => undefined
  );
  saveQueues.set(queueKey, settled);
  void settled.finally(() => {
    if (saveQueues.get(queueKey) === settled) saveQueues.delete(queueKey);
  });
  return operation;
}

async function saveSourceSidecarNow(
  target: SourceTarget,
  file: DocThreadFile,
  _revision: string | null
): Promise<LoadedSourceSidecar> {
  if (target.kind === 'ado-workitem') {
    throw new Error('ADO work-item reviews persist via saveAdoReview, not the repo sidecar path.');
  }
  const expectedSource = persistedSource(target);
  const decoded = decodeDocThreadFile(file, { remote: true, expectedSource });
  if (decoded.schemaVersion !== 2) {
    throw new Error('Repository review writes require a schema-v2 sidecar.');
  }

  const queueKey = sourceStorageKey(target);
  let local = decoded;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await loadSourceSidecar(target);
    const merged = latest.file ? mergeDocThreadFiles(local, latest.file) : local;
    try {
      if (target.kind === 'azure-repos') {
        const revision = await azureRepos.saveSidecar(
          target,
          merged,
          latest.revision,
          latest.hasV2
        );
        return { file: merged, revision, hasV2: true };
      }
      // Base the commit on our own last-written tip when we have one — GitHub's
      // ref read (in loadSourceSidecar) lags behind our just-written commits and
      // would otherwise cause a non-fast-forward 422 storm across the serialized
      // saves a single comment triggers.
      const base = githubSidecarTip.get(queueKey) || latest.revision;
      const revision = await saveSidecarToGitHubAtomic(
        '',
        githubTarget(target),
        merged,
        base
      );
      githubSidecarTip.set(queueKey, revision);
      return { file: merged, revision, hasV2: true };
    } catch (error: any) {
      // Our cached tip may be wrong (a genuine external advance) — drop it so the
      // next attempt re-reads GitHub.
      githubSidecarTip.delete(queueKey);
      if (!isCasConflict(error) || attempt === 2) throw error;
      local = merged;
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + Math.floor(Math.random() * 60))
      );
    }
  }
  throw new Error('Review save exhausted its conflict retries.');
}

interface RawSidecars {
  v2: { value: unknown; contentRevision: string | null } | null;
  legacy: { value: unknown; contentRevision: string | null } | null;
  revision: string | null;
}

function persistedSource(
  target: Exclude<SourceTarget, { kind: 'ado-workitem' }>
): PersistedRepositoryIdentity {
  return { provider: target.kind, path: target.path };
}

function legacyStorageKey(target: Exclude<SourceTarget, { kind: 'ado-workitem' }>): string {
  const repository =
    target.kind === 'github'
      ? `${target.owner}/${target.repo}`
      : `${target.organization}/${target.project}/${target.repo}`;
  return `${repository}/${target.path}@${target.ref || 'default branch'}`;
}

function migrateLegacy(
  target: Exclude<SourceTarget, { kind: 'ado-workitem' }>,
  legacy: DocThreadFileV1,
  contentRevision: string | null
): DocThreadFileV2 {
  if (legacy.docPath !== target.path && legacy.docPath !== legacyStorageKey(target)) {
    throw new Error(
      `Legacy review sidecar was quarantined because its docPath does not exactly match ${target.path}.`
    );
  }
  return {
    schemaVersion: 2,
    source: persistedSource(target),
    docPath: target.path,
    threads: sanitizeLegacyThreadsForMigration(legacy.threads),
    updatedAt: legacy.updatedAt,
    ...(legacy.markdown === undefined ? {} : { markdown: legacy.markdown }),
    ...(legacy.meta === undefined ? {} : { meta: legacy.meta }),
    ...(contentRevision
      ? { legacyPath: sidecarPath(target.path), legacyRevision: contentRevision }
      : {}),
  };
}

function decodeRepositorySidecars(
  target: Exclude<SourceTarget, { kind: 'ado-workitem' }>,
  raw: RawSidecars
): LoadedSourceSidecar {
  const expectedSource = persistedSource(target);
  if (raw.v2) {
    const decoded = decodeDocThreadFile(raw.v2.value, { remote: true, expectedSource });
    if (decoded.schemaVersion !== 2) {
      throw new Error('The schema-v2 path contains a legacy sidecar.');
    }
    if (decoded.legacyPath && decoded.legacyPath !== sidecarPath(target.path)) {
      throw new Error('The schema-v2 sidecar records an unexpected legacy path.');
    }
    if (
      decoded.legacyRevision &&
      raw.legacy?.contentRevision &&
      decoded.legacyRevision !== raw.legacy.contentRevision
    ) {
      throw new Error('A legacy client changed this review after v2 migration; reconcile it explicitly.');
    }
    return { file: decoded, revision: raw.revision, hasV2: true };
  }
  if (!raw.legacy) return { file: null, revision: raw.revision, hasV2: false };
  const legacy = decodeDocThreadFile(raw.legacy.value, { remote: true });
  if (legacy.schemaVersion !== 1) {
    throw new Error('The legacy sidecar path contains a schema-v2 file.');
  }
  return {
    file: migrateLegacy(target, legacy, raw.legacy.contentRevision),
    revision: raw.revision,
    hasV2: false,
  };
}

function isCasConflict(error: any): boolean {
  return error?.status === 409 || error?.status === 412 || error?.status === 422;
}

export async function commitSourceDocument(
  target: SourceTarget,
  markdown: string,
  revision: string | null,
  message?: string
): Promise<string> {
  if (target.kind === 'ado-workitem') {
    const updated = await adoWorkItems.updateDocument(target, markdown, revision);
    return updated.revision;
  }
  if (target.kind === 'azure-repos') {
    return azureRepos.commitDocument(target, markdown, revision, message);
  }
  return commitDocToGitHub('', githubTarget(target), markdown, revision, message);
}

export async function createSourceDocumentPullRequest(
  target: SourceTarget,
  markdown: string,
  revision: string | null,
  options?: { title?: string; body?: string }
): Promise<SourcePullRequest> {
  if (target.kind === 'ado-workitem') {
    throw new Error('Azure DevOps work-item descriptions do not support pull requests.');
  }
  if (target.kind === 'azure-repos') {
    return azureRepos.createDocumentPullRequest(target, markdown, revision, options);
  }
  return createDocEditPR('', githubTarget(target), markdown, revision, options);
}

export function sourceProviderName(target: SourceTarget): string {
  if (target.kind === 'github') return 'GitHub';
  return target.kind === 'azure-repos' ? 'Azure Repos' : 'ADO work item';
}

export function sourceRepositoryLabel(target: SourceTarget): string {
  if (target.kind === 'github') return `${target.owner}/${target.repo}`;
  if (target.kind === 'azure-repos') {
    return `${target.organization}/${target.project}/${target.repo}`;
  }
  return `${target.organization}/${target.project ?? '-'}`;
}

export function sourceReferenceLabel(target: SourceTarget): string {
  return target.kind === 'ado-workitem' ? `work item #${target.id}` : target.ref || 'default branch';
}

export function sourceDocumentLabel(target: SourceTarget): string {
  return target.kind === 'ado-workitem' ? `#${target.id}` : target.path;
}

export function sourceStorageKey(target: SourceTarget): string {
  if (target.kind === 'github') {
    return localStorageKeyV2({
      provider: 'github',
      owner: target.owner,
      repo: target.repo,
      versionType: target.versionType,
      ref: target.ref,
      path: target.path,
    });
  }
  if (target.kind === 'azure-repos') {
    if (!target.ref) throw new Error('Azure Repos target must resolve a ref before local storage.');
    return localStorageKeyV2({
      provider: 'azure-repos',
      organization: target.organization,
      project: target.project,
      repo: target.repo,
      versionType: target.versionType,
      ref: target.ref,
      path: target.path,
    });
  }
  if (!target.project) throw new Error('ADO work item must resolve a project before local storage.');
  return localStorageKeyV2({
    provider: 'ado-workitem',
    organization: target.organization,
    project: target.project,
    id: target.id,
  });
}

export function sourceFileUrl(target: SourceTarget): string {
  if (target.kind === 'github') return docBlobUrl(githubTarget(target));
  return target.kind === 'azure-repos' ? azureRepos.fileUrl(target) : workItemUrl(target);
}

export function sourceIsWritable(target: SourceTarget): boolean {
  return (
    (target.kind === 'github' && target.versionType === 'branch') ||
    target.kind === 'ado-workitem' ||
    (target.versionType === 'branch' && Boolean(target.ref))
  );
}

export function sourceSupportsPullRequest(target: SourceTarget): boolean {
  return (
    target.kind === 'azure-repos' ||
    (target.kind === 'github' && target.versionType === 'branch')
  );
}

export function sourceDeepLink(
  appUrl: string,
  target: SourceTarget,
  threadId?: string
): string {
  const url = new URL(appUrl);
  if (target.kind === 'github') {
    url.search = buildGitHubTargetDeepLinkParams(target);
  } else {
    url.searchParams.set('source', target.kind);
    url.searchParams.set('doc', sourceFileUrl(target));
  }
  const base = url.toString();
  return threadId ? withThreadParam(base, threadId) : base;
}

export function sourceAccessConfigured(target: SourceTarget): boolean {
  return target.kind === 'github' || ADO_TRANSPORT !== 'off';
}