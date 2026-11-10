import type { AzureReposTarget } from './source.ts';

export const AZURE_DEVOPS_API_VERSION = '7.1';

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function azureReposRepositoryApiPath(target: AzureReposTarget): string {
  return `/${segment(target.organization)}/${segment(target.project)}/_apis/git/repositories/${segment(
    target.repo
  )}`;
}

export function azureReposItemPath(target: AzureReposTarget, itemPath = target.path): string {
  const query = new URLSearchParams({
    path: `/${itemPath.replace(/^\/+/, '')}`,
    includeContent: 'true',
    resolveLfs: 'true',
    'api-version': AZURE_DEVOPS_API_VERSION,
  });
  if (target.ref) {
    query.set('versionDescriptor.version', target.ref);
    query.set('versionDescriptor.versionType', target.versionType);
  }
  return `${azureReposRepositoryApiPath(target)}/items?${query}`;
}

export function azureReposRefsPath(target: AzureReposTarget, branch: string): string {
  const query = new URLSearchParams({
    filter: `heads/${branch}`,
    'api-version': AZURE_DEVOPS_API_VERSION,
  });
  return `${azureReposRepositoryApiPath(target)}/refs?${query}`;
}

export function azureReposPushesPath(target: AzureReposTarget): string {
  return `${azureReposRepositoryApiPath(target)}/pushes?api-version=${AZURE_DEVOPS_API_VERSION}`;
}

export function azureReposPullRequestsPath(target: AzureReposTarget): string {
  return `${azureReposRepositoryApiPath(target)}/pullrequests?api-version=${AZURE_DEVOPS_API_VERSION}`;
}

export function writableAzureReposBranch(target: AzureReposTarget): string {
  if (target.versionType !== 'branch' || !target.ref) {
    throw new Error('Azure Repos writes require a file URL pinned to a branch.');
  }
  return target.ref;
}

export interface AzureReposPushBody {
  refUpdates: { name: string; oldObjectId: string }[];
  commits: {
    comment: string;
    parents?: string[];
    changes: {
      changeType: 'add' | 'edit';
      item: { path: string };
      newContent: { content: string; contentType: 'rawtext' };
    }[];
  }[];
}

export function buildAzureReposPush(
  branch: string,
  oldObjectId: string,
  itemPath: string,
  content: string,
  exists: boolean,
  comment: string,
  parentCommit?: string
): AzureReposPushBody {
  return {
    refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }],
    commits: [
      {
        comment,
        ...(parentCommit ? { parents: [parentCommit] } : {}),
        changes: [
          {
            changeType: exists ? 'edit' : 'add',
            item: { path: `/${itemPath.replace(/^\/+/, '')}` },
            newContent: { content, contentType: 'rawtext' },
          },
        ],
      },
    ],
  };
}

export function azureReposFileUrl(target: AzureReposTarget): string {
  const url = new URL(
    `https://dev.azure.com/${segment(target.organization)}/${segment(target.project)}/_git/${segment(
      target.repo
    )}`
  );
  url.searchParams.set('path', `/${target.path.replace(/^\/+/, '')}`);
  if (target.ref) {
    const prefix = target.versionType === 'tag' ? 'GT' : target.versionType === 'commit' ? 'GC' : 'GB';
    url.searchParams.set('version', `${prefix}${target.ref}`);
  }
  url.searchParams.set('_a', 'contents');
  return url.toString();
}

export function azureReposPullRequestUrl(target: AzureReposTarget, pullRequestId: number): string {
  return `https://dev.azure.com/${segment(target.organization)}/${segment(
    target.project
  )}/_git/${segment(target.repo)}/pullrequest/${pullRequestId}`;
}