import type { DocThreadFileV2 } from './types.ts';
import type { AzureReposTarget } from './source.ts';
import { sidecarPath, v2SidecarPath } from './source.ts';
import { ProviderError, requireProviderJson } from './providerError.ts';
import {
  azureReposFileUrl,
  azureReposItemPath,
  azureReposRepositoryApiPath,
  azureReposPullRequestUrl,
  azureReposPullRequestsPath,
  azureReposPushesPath,
  azureReposRefsPath,
  buildAzureReposPush,
  writableAzureReposBranch,
} from './azureReposApi.ts';

export interface AzureReposFile {
  text: string;
  revision: string | null;
}

export interface AzureReposSidecar {
  v2: { value: unknown; contentRevision: string | null } | null;
  legacy: { value: unknown; contentRevision: string | null } | null;
  revision: string | null;
}

export interface AzureReposPullRequest {
  url: string;
  branch: string;
  number: number;
}

export interface AzureReposClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  getAccessToken?: (interactive: boolean) => Promise<string>;
}

interface GitItemResponse {
  content?: string;
  isFolder?: boolean;
  objectId?: string;
}

interface GitRepositoryResponse {
  defaultBranch?: string;
}

interface GitRefsResponse {
  value?: { name?: string; objectId?: string }[];
}

interface GitPushResponse {
  commits?: { commitId?: string }[];
}

interface GitPullRequestResponse {
  pullRequestId?: number;
}

const ZERO_COMMIT = '0000000000000000000000000000000000000000';

export class AzureReposError extends ProviderError {}

function joinUrl(baseUrl: string, requestPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${requestPath}`;
}

export function createAzureReposClient(options: AzureReposClientOptions = {}) {
  const baseUrl = options.baseUrl || 'https://dev.azure.com';
  const fetchImpl = options.fetch || fetch;
  const getAccessToken = options.getAccessToken || (async () => '');

  async function request(
    target: AzureReposTarget,
    requestPath: string,
    init: RequestInit = {},
    allowInteractive = true
  ): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    let token = await getAccessToken(method !== 'GET');
    let attempt = 0;

    while (true) {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetchImpl(joinUrl(baseUrl, requestPath), { ...init, headers });

      if (response.status === 401 && allowInteractive && !token) {
        token = await getAccessToken(true);
        if (token) continue;
      }
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      try {
        return await requireProviderJson(response, {
          provider: 'Azure Repos',
          tokenSent: Boolean(token),
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new AzureReposError(error.kind, error.message, error.status);
        }
        throw error;
      }
    }
  }

  async function readItem(target: AzureReposTarget, itemPath: string): Promise<AzureReposFile> {
    const response = await request(target, azureReposItemPath(target, itemPath));
    const item = (await response.json()) as GitItemResponse;
    if (item.isFolder) throw new Error('That Azure Repos path is a folder, not a file.');
    if (typeof item.content !== 'string') {
      throw new Error('The Azure Repos file loaded but returned no text content.');
    }
    return { text: item.content, revision: item.objectId || null };
  }

  async function branchTip(target: AzureReposTarget, branch: string): Promise<string> {
    const response = await request(target, azureReposRefsPath(target, branch));
    const refs = (await response.json()) as GitRefsResponse;
    const exact = refs.value?.find((ref) => ref.name === `refs/heads/${branch}`);
    if (!exact?.objectId) throw new Error(`Azure Repos branch "${branch}" was not found.`);
    return exact.objectId;
  }

  async function pushFile(
    target: AzureReposTarget,
    itemPath: string,
    content: string,
    exists: boolean,
    comment: string,
    destinationBranch?: string,
    expectedHead?: string
  ): Promise<string> {
    const sourceBranch = writableAzureReposBranch(target);
    const branch = destinationBranch || sourceBranch;
    const sourceHead = expectedHead || (await branchTip(target, sourceBranch));
    const creatingBranch = branch !== sourceBranch;
    const body = buildAzureReposPush(
      branch,
      creatingBranch ? ZERO_COMMIT : sourceHead,
      itemPath,
      content,
      exists,
      comment,
      creatingBranch ? sourceHead : undefined
    );
    const response = await request(target, azureReposPushesPath(target), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const push = (await response.json()) as GitPushResponse;
    return push.commits?.[0]?.commitId || '';
  }

  return {
    async fetchMarkdown(
      target: AzureReposTarget,
      expectedHead?: string | null
    ): Promise<AzureReposFile> {
      if (target.versionType !== 'branch') return readItem(target, target.path);
      const branch = writableAzureReposBranch(target);
      const revision = expectedHead || (await branchTip(target, branch));
      const result = await readItem(
        { ...target, ref: revision, versionType: 'commit' },
        target.path
      );
      return { text: result.text, revision };
    },

    async resolveTarget(target: AzureReposTarget): Promise<AzureReposTarget> {
      if (target.ref) return target;
      const query = new URLSearchParams({ 'api-version': '7.1' });
      const response = await request(
        target,
        `${azureReposRepositoryApiPath(target)}?${query}`,
        {},
        false
      );
      const repository = (await response.json()) as GitRepositoryResponse;
      const ref = repository.defaultBranch?.replace(/^refs\/heads\//, '');
      if (!ref) throw new Error('Azure Repos did not return a default branch for this repository.');
      return { ...target, ref, versionType: 'branch' };
    },

    async loadSidecar(target: AzureReposTarget): Promise<AzureReposSidecar> {
      const branch = writableAzureReposBranch(target);
      const revision = await branchTip(target, branch);
      const pinned = { ...target, ref: revision, versionType: 'commit' as const };
      const readSidecar = async (path: string) => {
        try {
          const result = await readItem(pinned, path);
          return { value: JSON.parse(result.text), contentRevision: result.revision };
        } catch (error) {
          if (error instanceof AzureReposError && error.status === 404) return null;
          throw error;
        }
      };
      const [v2, legacy] = await Promise.all([
        readSidecar(v2SidecarPath(target.path)),
        readSidecar(sidecarPath(target.path)),
      ]);
      return { v2, legacy, revision };
    },

    async saveSidecar(
      target: AzureReposTarget,
      file: DocThreadFileV2,
      revision: string | null,
      exists: boolean
    ): Promise<string> {
      if (!revision) throw new Error('Azure Repos sidecar writes require an exact branch-head revision.');
      return pushFile(
        target,
        v2SidecarPath(target.path),
        JSON.stringify(file, null, 2),
        exists,
        `docthread: update review threads for ${target.path}`,
        undefined,
        revision
      );
    },

    async commitDocument(
      target: AzureReposTarget,
      markdown: string,
      revision: string | null,
      message?: string
    ): Promise<string> {
      if (!revision) {
        throw new Error('Azure Repos document writes require an exact branch-head revision.');
      }
      return pushFile(
        target,
        target.path,
        markdown,
        true,
        message || `docthread: edit ${target.path}`,
        undefined,
        revision
      );
    },

    async createDocumentPullRequest(
      target: AzureReposTarget,
      markdown: string,
      revision: string | null,
      options?: { title?: string; body?: string }
    ): Promise<AzureReposPullRequest> {
      const targetBranch = writableAzureReposBranch(target);
      const slug = target.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const branch = `docthread/edit-${slug}-${Date.now()}`.slice(0, 240);
      await pushFile(
        target,
        target.path,
        markdown,
        revision !== null,
        options?.title || `docthread: edit ${target.path}`,
        branch,
        revision || undefined
      );

      const response = await request(target, azureReposPullRequestsPath(target), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: `refs/heads/${targetBranch}`,
          title: options?.title || `DocThread edit: ${target.path}`,
          description: options?.body || 'Edited via DocThread.',
        }),
      });
      const pullRequest = (await response.json()) as GitPullRequestResponse;
      if (!pullRequest.pullRequestId) throw new Error('Azure Repos did not return a pull request ID.');
      return {
        url: azureReposPullRequestUrl(target, pullRequest.pullRequestId),
        branch,
        number: pullRequest.pullRequestId,
      };
    },

    fileUrl: azureReposFileUrl,
  };
}