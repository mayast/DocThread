export type IdentityAuthority = 'github' | 'entra' | 'azure-devops';

export interface ProviderIdentity {
  key: string;
  authority: IdentityAuthority;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  externalHint?: 'b2b-guest';
}

export interface IdentitySubject {
  subjectKey: string;
  linkedKeys: string[];
  displayName: string;
  identities: ProviderIdentity[];
}

export type IdentitySource = 'you' | 'participant' | 'github' | 'entra' | 'azure-devops';

export interface SearchCandidate {
  readonly subject: IdentitySubject;
  readonly source: IdentitySource;
  readonly handle: string;
  readonly avatarUrl?: string;
  readonly externalHint?: 'b2b-guest';
  secondaryLabel(): string | undefined;
  assertedMailEquals(other: SearchCandidate): boolean;
  searchTerms(): readonly string[];
}

interface CandidateEvidence {
  mail?: string;
  userPrincipalName?: string;
  assertedBy?: IdentityAuthority;
  externalHint?: 'b2b-guest';
}

const assertedMailEvidence = new WeakMap<SearchCandidate, string>();

export class IdentitySearchError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'IdentitySearchError';
    this.status = status;
    this.code = code;
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeMail(value?: string): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized && normalized.includes('@') ? normalized : undefined;
}

export function identityDisplayName(displayName?: string, handle?: string): string {
  const value = (displayName || handle || '').trim();
  const email = /^([^@\s]+)@[^@\s]+$/.exec(value);
  return email ? email[1] : value;
}

export function durableIdentityHandle(handle?: string): string | undefined {
  const value = handle?.trim();
  if (!value) return undefined;
  const email = /^([^@\s]+)@[^@\s]+$/.exec(value);
  return email ? email[1] : value;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function makeSearchCandidate(
  subject: IdentitySubject,
  source: IdentitySource,
  handle: string,
  evidence: CandidateEvidence = {},
  avatarUrl?: string
): SearchCandidate {
  const mail = evidence.assertedBy ? normalizeMail(evidence.mail) : undefined;
  const upn = evidence.userPrincipalName?.trim();
  const externalHint =
    evidence.externalHint ||
    (upn?.toLocaleUpperCase().includes('#EXT#') ? 'b2b-guest' : undefined);
  const searchTerms = uniqueSorted(
    [subject.displayName, handle, mail || '', upn || ''].map(normalize).filter(Boolean)
  );

  const candidate: SearchCandidate = {
    subject,
    source,
    handle,
    avatarUrl,
    externalHint,
    secondaryLabel: () => mail || upn,
    assertedMailEquals: (other) => {
      if (!mail) return false;
      return assertedMailEvidence.get(other) === mail;
    },
    searchTerms: () => searchTerms,
  };
  if (mail) assertedMailEvidence.set(candidate, mail);
  return candidate;
}

export interface GraphUser {
  id: string;
  displayName: string;
  givenName?: string | null;
  surname?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

interface GraphUsersResponse {
  '@odata.count'?: number;
  value?: GraphUser[];
  error?: { code?: string; message?: string };
}

function validatedTerm(term: string): string {
  const value = term.trim();
  if (value.length < 2) return '';
  if (value.length > 80) throw new IdentitySearchError('Identity search is limited to 80 characters.', 400);
  return value;
}

function graphSearchExpression(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"displayName:${escaped}" OR "mail:${escaped}" OR "userPrincipalName:${escaped}"`;
}

export function graphUsersSearchUrl(term: string): string | null {
  const value = validatedTerm(term);
  if (!value) return null;
  const query = new URLSearchParams({
    '$search': graphSearchExpression(value),
    '$count': 'true',
    '$select': 'id,displayName,givenName,surname,mail,userPrincipalName',
    '$top': '10',
  });
  return `https://graph.microsoft.com/v1.0/users?${query}`;
}

export async function searchGraphUsers(
  fetchImpl: typeof fetch,
  accessToken: string,
  tenantId: string,
  term: string,
  signal?: AbortSignal
): Promise<SearchCandidate[]> {
  const url = graphUsersSearchUrl(term);
  if (!url) return [];
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ConsistencyLevel: 'eventual',
    },
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as GraphUsersResponse;
  if (!response.ok) {
    throw new IdentitySearchError(
      payload.error?.message || `Microsoft Graph identity search failed (${response.status}).`,
      response.status,
      payload.error?.code
    );
  }

  return (payload.value || [])
    .filter((user) => Boolean(user.id && user.displayName))
    .map((user) => {
      const key = `entra:${tenantId}:${user.id}`;
      const handle = user.userPrincipalName?.split('@')[0] || user.mail?.split('@')[0] || user.displayName;
      const identity: ProviderIdentity = {
        key,
        authority: 'entra',
        displayName: user.displayName,
        handle,
        externalHint: user.userPrincipalName?.toLocaleUpperCase().includes('#EXT#')
          ? 'b2b-guest'
          : undefined,
      };
      return makeSearchCandidate(
        {
          subjectKey: key,
          linkedKeys: [key],
          displayName: user.displayName,
          identities: [identity],
        },
        'entra',
        handle,
        {
          mail: user.mail || undefined,
          userPrincipalName: user.userPrincipalName || undefined,
          assertedBy: 'entra',
        }
      );
    });
}

export interface GitHubRepositoryIdentity {
  owner: string;
  repo: string;
}

interface GitHubNotificationPreflightResponse {
  data?: {
    viewer?: { id?: string; login?: string } | null;
    nodes?: Array<{ id?: string; login?: string } | null> | null;
    repository?: {
      hasIssuesEnabled?: boolean;
      viewerPermission?: string | null;
    } | null;
  };
  errors?: Array<{ type?: string; message?: string }>;
}

const NOTIFICATION_PREFLIGHT_QUERY = `
  query DocThreadNotificationPreflight($owner: String!, $repo: String!, $ids: [ID!]!) {
    viewer { id login }
    nodes(ids: $ids) { ... on User { id login } }
    repository(owner: $owner, name: $repo) { hasIssuesEnabled viewerPermission }
  }
`;

const ISSUE_WRITE_PERMISSIONS = new Set(['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);

export async function verifyGitHubNotificationRecipients(
  fetchImpl: typeof fetch,
  apiBase: string,
  accessToken: string,
  repository: GitHubRepositoryIdentity,
  recipients: ReadonlyArray<{ nodeId: string }>,
  expectedViewerNodeId: string,
  signal?: AbortSignal
): Promise<string[]> {
  const nodeIds = [...new Set(recipients.map((recipient) => recipient.nodeId))].sort();
  if (nodeIds.length === 0) return [];
  const localProxy = new URL(githubGraphqlUrl(apiBase), 'http://localhost').pathname.startsWith(
    '/gh-api'
  );
  const response = await fetchImpl(githubGraphqlUrl(apiBase), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(localProxy ? { 'X-DocThread-Viewer-Node-Id': expectedViewerNodeId } : {}),
    },
    body: JSON.stringify({
      query: NOTIFICATION_PREFLIGHT_QUERY,
      variables: { owner: repository.owner, repo: repository.repo, ids: nodeIds },
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as GitHubNotificationPreflightResponse;
  const firstError = payload.errors?.[0];
  if (!response.ok || firstError) {
    throw new IdentitySearchError(
      firstError?.message || `GitHub notification preflight failed (${response.status}).`,
      response.status,
      firstError?.type
    );
  }
  if (payload.data?.viewer?.id !== expectedViewerNodeId) {
    throw new IdentitySearchError(
      'The signed-in GitHub account no longer matches the persisted comment author.',
      409
    );
  }
  if (!payload.data?.repository?.hasIssuesEnabled) {
    throw new IdentitySearchError('GitHub Issues are disabled for this repository.', 409);
  }
  const permission = payload.data.repository.viewerPermission || '';
  if (!ISSUE_WRITE_PERMISSIONS.has(permission)) {
    throw new IdentitySearchError(
      'Your GitHub account cannot create issue notifications in this repository.',
      403
    );
  }

  const byId = new Map(
    (payload.data.nodes || []).flatMap((node) =>
      node?.id && node.login ? [[node.id, node.login] as const] : []
    )
  );
  if (nodeIds.some((nodeId) => !byId.has(nodeId))) {
    throw new IdentitySearchError('A selected GitHub identity no longer resolves.', 409);
  }

  const handles: string[] = [];
  for (const nodeId of nodeIds) {
    const login = byId.get(nodeId)!;
    const collaborators = await searchGitHubCollaborators(
      fetchImpl,
      apiBase,
      accessToken,
      repository,
      login,
      signal
    );
    if (!collaborators.some((candidate) => candidate.subject.subjectKey === `github:${nodeId}`)) {
      throw new IdentitySearchError(
        `${login} is no longer a collaborator on ${repository.owner}/${repository.repo}.`,
        409
      );
    }
    handles.push(login);
  }
  return handles;
}

interface GitHubCollaboratorNode {
  id: string;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

interface GitHubCollaboratorResponse {
  data?: {
    repository?: {
      collaborators?: { nodes?: Array<GitHubCollaboratorNode | null> | null } | null;
    } | null;
  };
  errors?: Array<{ type?: string; message?: string }>;
}

const COLLABORATOR_QUERY = `
  query DocThreadCollaborators($owner: String!, $repo: String!, $term: String!) {
    repository(owner: $owner, name: $repo) {
      collaborators(first: 10, affiliation: ALL, query: $term) {
        nodes { id login name avatarUrl }
      }
    }
  }
`;

export function githubGraphqlUrl(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}

export async function searchGitHubCollaborators(
  fetchImpl: typeof fetch,
  apiBase: string,
  accessToken: string,
  repository: GitHubRepositoryIdentity,
  term: string,
  signal?: AbortSignal
): Promise<SearchCandidate[]> {
  const value = validatedTerm(term);
  if (!value) return [];
  const response = await fetchImpl(githubGraphqlUrl(apiBase), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: COLLABORATOR_QUERY,
      variables: { owner: repository.owner, repo: repository.repo, term: value },
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as GitHubCollaboratorResponse;
  const firstError = payload.errors?.[0];
  if (!response.ok || firstError) {
    throw new IdentitySearchError(
      firstError?.message || `GitHub collaborator search failed (${response.status}).`,
      response.status,
      firstError?.type
    );
  }

  return (payload.data?.repository?.collaborators?.nodes || [])
    .filter((node): node is GitHubCollaboratorNode => Boolean(node?.id && node.login))
    .map((node) => {
      const key = `github:${node.id}`;
      const displayName = node.name?.trim() || node.login;
      const identity: ProviderIdentity = {
        key,
        authority: 'github',
        displayName,
        handle: node.login,
        avatarUrl: node.avatarUrl || undefined,
      };
      return makeSearchCandidate(
        {
          subjectKey: key,
          linkedKeys: [key],
          displayName,
          identities: [identity],
        },
        'github',
        node.login,
        {},
        node.avatarUrl || undefined
      );
    });
}

interface GitHubPublicProfile {
  node_id?: string;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export async function joinGraphMailToGitHubCollaborators(
  fetchImpl: typeof fetch,
  apiBase: string,
  accessToken: string,
  repository: GitHubRepositoryIdentity,
  graphCandidates: readonly SearchCandidate[],
  signal?: AbortSignal
): Promise<SearchCandidate[]> {
  const possible = new Map<string, SearchCandidate>();
  for (const graphCandidate of graphCandidates) {
    const searches = [graphCandidate.handle, graphCandidate.subject.displayName];
    for (const term of searches) {
      const collaborators = await searchGitHubCollaborators(
        fetchImpl,
        apiBase,
        accessToken,
        repository,
        term,
        signal
      );
      for (const collaborator of collaborators) {
        possible.set(collaborator.subject.subjectKey, collaborator);
      }
    }
  }

  const joined: SearchCandidate[] = [];
  for (const collaborator of possible.values()) {
    const response = await fetchImpl(
      `${apiBase.replace(/\/+$/, '')}/users/${encodeURIComponent(collaborator.handle)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
        },
        signal,
      }
    );
    const profile = (await response.json().catch(() => ({}))) as GitHubPublicProfile;
    if (!response.ok) {
      throw new IdentitySearchError(
        `GitHub profile lookup failed (${response.status}).`,
        response.status
      );
    }
    if (
      !profile.node_id ||
      profile.node_id !== collaborator.subject.subjectKey.slice('github:'.length) ||
      !profile.login ||
      !profile.email
    ) {
      continue;
    }
    const assertedProfile = makeSearchCandidate(
      collaborator.subject,
      'github',
      profile.login,
      { mail: profile.email, assertedBy: 'github' },
      profile.avatar_url || collaborator.avatarUrl
    );
    const graphCandidate = graphCandidates.find((candidate) =>
      candidate.assertedMailEquals(assertedProfile)
    );
    if (!graphCandidate) continue;
    joined.push(
      makeSearchCandidate(
        {
          subjectKey: collaborator.subject.subjectKey,
          linkedKeys: uniqueSorted([
            ...collaborator.subject.linkedKeys,
            ...graphCandidate.subject.linkedKeys,
          ]),
          displayName:
            profile.name?.trim() ||
            collaborator.subject.displayName ||
            graphCandidate.subject.displayName,
          identities: [
            ...collaborator.subject.identities,
            ...graphCandidate.subject.identities,
          ],
        },
        'github',
        profile.login,
        {
          mail: profile.email,
          assertedBy: 'github',
          externalHint: graphCandidate.externalHint,
        },
        profile.avatar_url || collaborator.avatarUrl
      )
    );
  }
  return joined;
}

function scoreCandidate(candidate: SearchCandidate, term: string): number {
  const needle = normalize(term);
  const terms = candidate.searchTerms();
  if (terms.some((value) => value === needle)) return 0;
  if (terms.some((value) => value.split(/\s+/).some((part) => part.startsWith(needle)))) return 1;
  if (terms.some((value) => value.includes(needle))) return 2;
  return 3;
}

export function rankIdentityCandidates(
  candidates: SearchCandidate[],
  term: string,
  participantKeys: ReadonlySet<string> = new Set()
): SearchCandidate[] {
  const unique = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.subject.subjectKey)) unique.set(candidate.subject.subjectKey, candidate);
  }
  return [...unique.values()].sort((left, right) => {
    const score = scoreCandidate(left, term) - scoreCandidate(right, term);
    if (score) return score;
    const participant = Number(!participantKeys.has(left.subject.subjectKey)) - Number(!participantKeys.has(right.subject.subjectKey));
    if (participant) return participant;
    const guest = Number(Boolean(left.externalHint)) - Number(Boolean(right.externalHint));
    if (guest) return guest;
    return left.subject.subjectKey.localeCompare(right.subject.subjectKey);
  });
}
