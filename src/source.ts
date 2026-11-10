import type {
  CanonicalSourceIdentity,
  GitHubSourceTarget,
  GitHubTarget,
} from './types.ts';
import type { ParsedGitHubSourceUrl } from './githubSource.ts';
import { parseGitHubSourceUrl } from './githubSource.ts';

export type { GitHubSourceTarget } from './types.ts';
export {
  parseGitHubSourceUrl,
  parseGitHubSourceUrl as parseGitHubUrl,
} from './githubSource.ts';

export type SourceKind = 'github' | 'azure-repos' | 'ado-workitem';
export type AzureReposVersionType = 'branch' | 'tag' | 'commit';

export interface AzureReposTarget {
  kind: 'azure-repos';
  organization: string;
  project: string;
  repo: string;
  path: string;
  ref: string | null;
  versionType: AzureReposVersionType;
}

export interface AdoWorkItemTarget {
  kind: 'ado-workitem';
  organization: string;
  project?: string;
  id: number;
}

export type SourceTarget =
  | GitHubSourceTarget
  | AzureReposTarget
  | AdoWorkItemTarget;

export function sidecarPath(docPath: string): string {
  const flat = docPath.replace(/^\/+/, '').replace(/[\\/]/g, '__');
  return `.docthread/${flat}.json`;
}

function repositoryPathSegments(path: string): string[] {
  if (path.includes('\\')) {
    throw new Error('Repository paths must use forward slashes, not raw backslashes.');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Repository paths cannot contain empty, dot, or dot-dot segments.');
  }
  return segments;
}

function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    throw new Error('Repository paths must contain valid Unicode code points.');
  }
}

/** Collision-safe schema-v2 path. Raw segments are encoded independently and never normalized. */
export function v2SidecarPath(path: string): string {
  const encoded = repositoryPathSegments(path).map(encodePathSegment).join('/');
  return `.docthread/v2/${encoded}.json`;
}

function requireIdentityPart(value: string, name: string): string {
  if (!value) throw new Error(`Canonical source ${name} cannot be empty.`);
  return value;
}

/** Stable-key-ordered JSON for runtime source identity. */
export function canonicalSourceIdentityJson(identity: CanonicalSourceIdentity): string {
  if (identity.provider === 'github') {
    repositoryPathSegments(identity.path);
    return JSON.stringify({
      provider: identity.provider,
      owner: requireIdentityPart(identity.owner, 'owner'),
      repo: requireIdentityPart(identity.repo, 'repo'),
      versionType: identity.versionType,
      ref: requireIdentityPart(identity.ref, 'ref'),
      path: identity.path,
    });
  }

  if (identity.provider === 'azure-repos') {
    repositoryPathSegments(identity.path);
    return JSON.stringify({
      provider: identity.provider,
      organization: requireIdentityPart(identity.organization, 'organization'),
      project: requireIdentityPart(identity.project, 'project'),
      repo: requireIdentityPart(identity.repo, 'repo'),
      versionType: identity.versionType,
      ref: requireIdentityPart(identity.ref, 'ref'),
      path: identity.path,
    });
  }

  if (!Number.isSafeInteger(identity.id) || identity.id <= 0) {
    throw new Error('Canonical work-item IDs must be positive safe integers.');
  }
  return JSON.stringify({
    provider: identity.provider,
    organization: requireIdentityPart(identity.organization, 'organization'),
    project: requireIdentityPart(identity.project, 'project'),
    id: identity.id,
  });
}

function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function localStorageKeyV2(identity: CanonicalSourceIdentity): string {
  return `docthread:v2:${base64UrlUtf8(canonicalSourceIdentityJson(identity))}`;
}

export function adoWorkItemDocPath(target: AdoWorkItemTarget): string {
  return `ado:${target.organization}/${target.project ?? '-'}/${target.id}`;
}

export function githubRawUrl(target: GitHubTarget, path = target.path): string {
  const encodePath = (value: string) => value.split('/').map(encodePathSegment).join('/');
  const readRef = target.commitSha || target.ref;
  return `https://raw.githubusercontent.com/${encodePathSegment(target.owner)}/${encodePathSegment(
    target.repo
  )}/${encodePathSegment(readRef)}/${encodePath(path.replace(/^\/+/, ''))}`;
}

export function githubBlobUrl(target: GitHubTarget): string {
  const encodedPath = target.path.split('/').map(encodePathSegment).join('/');
  return `https://github.com/${encodePathSegment(target.owner)}/${encodePathSegment(
    target.repo
  )}/blob/${encodePathSegment(target.ref)}/${encodedPath}`;
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a canonical dev.azure.com or legacy visualstudio.com Azure Repos file URL. */
export function parseAzureReposUrl(value: string): AzureReposTarget | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean).map(decodePart);

    let organization: string | undefined;
    let project: string | undefined;
    let repo: string | undefined;

    if (host === 'dev.azure.com') {
      [organization, project] = parts;
      if (parts[2]?.toLowerCase() !== '_git') return null;
      repo = parts[3];
    } else if (host.endsWith('.visualstudio.com')) {
      organization = decodePart(host.slice(0, -'.visualstudio.com'.length));
      [project] = parts;
      if (parts[1]?.toLowerCase() !== '_git') return null;
      repo = parts[2];
    } else {
      return null;
    }

    const path = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!organization || !project || !repo || !path) return null;

    const version = url.searchParams.get('version');
    const prefix = version?.slice(0, 2).toUpperCase();
    const versionType: AzureReposVersionType =
      prefix === 'GT' ? 'tag' : prefix === 'GC' ? 'commit' : 'branch';
    const ref = version ? (prefix === 'GB' || prefix === 'GT' || prefix === 'GC' ? version.slice(2) : version) : null;

    return { kind: 'azure-repos', organization, project, repo, path, ref, versionType };
  } catch {
    return null;
  }
}

export function parseAdoWorkItemUrl(value: string): AdoWorkItemTarget | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean).map(decodePart);
    const workItemsIndex = parts.findIndex((part) => part.toLowerCase() === '_workitems');
    const editIndex = parts.findIndex((part) => part.toLowerCase() === 'edit');
    const id = editIndex >= 0 ? Number(parts[editIndex + 1]) : NaN;
    if (workItemsIndex < 0 || !Number.isInteger(id) || id <= 0) return null;

    if (host === 'dev.azure.com') {
      const organization = parts[0];
      const project = workItemsIndex > 1 ? parts[1] : undefined;
      return organization ? { kind: 'ado-workitem', organization, project, id } : null;
    }

    if (host.endsWith('.visualstudio.com')) {
      const organization = decodePart(host.slice(0, -'.visualstudio.com'.length));
      const project = workItemsIndex > 0 ? parts[0] : undefined;
      return organization ? { kind: 'ado-workitem', organization, project, id } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseSourceUrl(
  value: string
): ParsedGitHubSourceUrl | AzureReposTarget | AdoWorkItemTarget | null {
  return parseGitHubSourceUrl(value) ?? parseAzureReposUrl(value) ?? parseAdoWorkItemUrl(value);
}