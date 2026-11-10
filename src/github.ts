import { Octokit } from '@octokit/rest';
import type { DocThreadFile, DocThreadFileV2, GitHubTarget } from './types';
import { AUTH_MODE, GH_API_BASE, getToken } from './auth';
import { fetchPublicGitHubText } from './githubPublic';
import { decodeDocThreadFile } from './reviewSchema';

export { parseGitHubUrl, sidecarPath, v2SidecarPath } from './source';
import { githubBlobUrl, sidecarPath, v2SidecarPath } from './source';

// In dev, calls go through the same-origin Vite proxy (/gh-api), which injects the
// machine's `gh` CLI token server-side. In the hosted (oauth) build, GH_API_BASE is
// https://api.github.com — which supports CORS — and we attach the signed-in user's
// token directly. An explicit `token` argument always overrides.
function makeOctokit(token?: string): Octokit {
  const t = token || getToken();
  return t
    ? new Octokit({ auth: t, baseUrl: GH_API_BASE })
    : new Octokit({ baseUrl: GH_API_BASE });
}

// Base64 helpers that are safe for UTF-8 content.
function toB64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
function fromB64(s: string): string {
  return decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
}

export async function fetchMarkdown(
  token: string,
  t: GitHubTarget
): Promise<{ text: string; sha: string | null }> {
  if (AUTH_MODE === 'static') {
    const result = await fetchPublicGitHubText(t);
    if (!result) throw new Error('That public GitHub file was not found.');
    return { text: result.text, sha: null };
  }

  const octokit = makeOctokit(token);
  const readRef = t.commitSha || t.ref;
  // IMPORTANT: do NOT use mediaType 'raw' in the browser. For private repos GitHub
  // answers the raw Accept header with a 302 to raw.githubusercontent.com, which sends
  // no CORS headers -> the browser throws "Failed to fetch". The default JSON response
  // (base64) is served directly by api.github.com with CORS, so it always works.
  const res = await octokit.repos.getContent({
    owner: t.owner,
    repo: t.repo,
    path: t.path,
    ref: readRef,
  });
  const data = res.data as { type?: string; content?: string; sha?: string; size?: number };
  if (Array.isArray(res.data)) {
    throw new Error('That path is a folder, not a file. Point at a single .md file.');
  }
  const sha = data.sha ?? null;
  if (data.content && data.content.trim()) {
    return { text: fromB64(data.content), sha };
  }
  // Files > 1 MB come back with empty content; fetch via the git blob API (also
  // base64 JSON on api.github.com, CORS-safe, up to 100 MB).
  if (data.sha) {
    const blob = await octokit.git.getBlob({ owner: t.owner, repo: t.repo, file_sha: data.sha });
    if (blob.data.content) return { text: fromB64(blob.data.content), sha };
  }
  throw new Error('File loaded but returned no text content.');
}

export interface RawRepositorySidecar {
  value: unknown;
  contentRevision: string | null;
}

export interface RawRepositorySidecars {
  v2: RawRepositorySidecar | null;
  legacy: RawRepositorySidecar | null;
  /** Branch-head commit used as the write CAS token. */
  revision: string | null;
}

async function publicJsonAtPath(
  t: GitHubTarget,
  path: string
): Promise<RawRepositorySidecar | null> {
  const result = await fetchPublicGitHubText(t, path);
  if (!result) return null;
  return { value: JSON.parse(result.text), contentRevision: null };
}

async function githubJsonAtPath(
  octokit: Octokit,
  t: GitHubTarget,
  path: string,
  ref: string
): Promise<RawRepositorySidecar | null> {
  try {
    const response = await octokit.repos.getContent({
      owner: t.owner,
      repo: t.repo,
      path,
      ref,
    });
    const data = response.data as { type?: string; content?: string; sha?: string };
    if (Array.isArray(response.data) || data.type === 'dir') {
      throw new Error(`${path} is a directory, not a DocThread sidecar.`);
    }
    if (!data.content) throw new Error(`${path} returned no JSON content.`);
    return {
      value: JSON.parse(fromB64(data.content)),
      contentRevision: data.sha || null,
    };
  } catch (error: any) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function loadSidecarsFromGitHub(
  token: string,
  t: GitHubTarget
): Promise<RawRepositorySidecars> {
  const v2Path = v2SidecarPath(t.path);
  const legacyPath = sidecarPath(t.path);
  if (AUTH_MODE === 'static') {
    const [v2, legacy] = await Promise.all([
      publicJsonAtPath(t, v2Path),
      publicJsonAtPath(t, legacyPath),
    ]);
    return { v2, legacy, revision: null };
  }

  const octokit = makeOctokit(token);
  let revision: string | null = null;
  if ((t.versionType || 'branch') === 'branch') {
    const ref = await octokit.git.getRef({ owner: t.owner, repo: t.repo, ref: `heads/${t.ref}` });
    revision = ref.data.object.sha;
  }
  const readRef = revision || t.commitSha || t.ref;
  const [v2, legacy] = await Promise.all([
    githubJsonAtPath(octokit, t, v2Path, readRef),
    githubJsonAtPath(octokit, t, legacyPath, readRef),
  ]);
  return { v2, legacy, revision };
}

export async function saveSidecarToGitHubAtomic(
  token: string,
  t: GitHubTarget,
  file: DocThreadFileV2,
  expectedHead: string | null
): Promise<string> {
  if (t.versionType && t.versionType !== 'branch') {
    throw new Error('GitHub sidecar writes require a verified branch target.');
  }
  if (!expectedHead) throw new Error('GitHub sidecar writes require an exact branch-head revision.');
  const octokit = makeOctokit(token);
  const path = v2SidecarPath(t.path);
  // The blob content is identical across attempts, so create it once.
  const blob = await octokit.git.createBlob({
    owner: t.owner,
    repo: t.repo,
    content: JSON.stringify(file, null, 2),
    encoding: 'utf-8',
  });

  // Build a commit that overwrites the sidecar file on top of `base` and
  // fast-forward the branch to it.
  const commitOnto = async (base: string): Promise<string> => {
    const parent = await octokit.git.getCommit({ owner: t.owner, repo: t.repo, commit_sha: base });
    const tree = await octokit.git.createTree({
      owner: t.owner,
      repo: t.repo,
      base_tree: parent.data.tree.sha,
      tree: [{ path, mode: '100644', type: 'blob', sha: blob.data.sha }],
    });
    const commit = await octokit.git.createCommit({
      owner: t.owner,
      repo: t.repo,
      message: `docthread: update review threads for ${t.path}`,
      tree: tree.data.sha,
      parents: [base],
    });
    await octokit.git.updateRef({
      owner: t.owner,
      repo: t.repo,
      ref: `heads/${t.ref}`,
      sha: commit.data.sha,
      force: false,
    });
    return commit.data.sha;
  };

  // A "not a fast forward" (HTTP 422) means the branch tip advanced after we read
  // `expectedHead` — commonly our own earlier save/edit in this session, or a
  // brief GitHub ref read-lag. Re-read the real tip and rebuild the sidecar commit
  // onto it. We only ever write the single sidecar file (the review content was
  // already merged upstream), so re-parenting onto the latest tip is safe.
  let base = expectedHead;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await commitOnto(base);
    } catch (error: any) {
      if (error?.status !== 422 || attempt === 3) throw error;
      const ref = await octokit.git.getRef({
        owner: t.owner,
        repo: t.repo,
        ref: `heads/${t.ref}`,
      });
      const freshTip = ref.data.object.sha;
      if (freshTip === base) {
        // The tip returned still equals our stale base (ref read-lag): wait for
        // GitHub to converge, then re-read on the next attempt.
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      } else {
        base = freshTip;
      }
    }
  }
  throw new Error('GitHub sidecar update could not fast-forward the branch.');
}

// ---- Editing the source document (commit or PR) --------------------------

/** Commit edited Markdown straight to the file on its branch. Returns the new blob SHA. */
export async function commitDocToGitHub(
  token: string,
  t: GitHubTarget,
  markdown: string,
  sha: string | null,
  message?: string
): Promise<string> {
  if (t.versionType && t.versionType !== 'branch') {
    throw new Error('GitHub document writes require a verified branch target.');
  }
  const octokit = makeOctokit(token);
  const res = await octokit.repos.createOrUpdateFileContents({
    owner: t.owner,
    repo: t.repo,
    path: t.path,
    branch: t.ref,
    message: message ?? `docthread: edit ${t.path}`,
    content: toB64(markdown),
    sha: sha ?? undefined,
  });
  return (res.data.content?.sha as string) ?? '';
}

/**
 * Open a pull request with the edited Markdown: branches off the target ref,
 * commits the change on the new branch, and creates a PR back into the target ref.
 */
export async function createDocEditPR(
  token: string,
  t: GitHubTarget,
  markdown: string,
  sha: string | null,
  opts?: { title?: string; body?: string }
): Promise<{ url: string; branch: string; number: number }> {
  if (t.versionType && t.versionType !== 'branch') {
    throw new Error('Pull requests from immutable GitHub refs are not supported in this release.');
  }
  const octokit = makeOctokit(token);

  // Base commit SHA of the target branch.
  const ref = await octokit.git.getRef({ owner: t.owner, repo: t.repo, ref: `heads/${t.ref}` });
  const baseSha = ref.data.object.sha;

  const slug = t.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const branch = `docthread/edit-${slug}-${Date.now()}`.slice(0, 240);

  await octokit.git.createRef({
    owner: t.owner,
    repo: t.repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  await octokit.repos.createOrUpdateFileContents({
    owner: t.owner,
    repo: t.repo,
    path: t.path,
    branch,
    message: opts?.title ?? `docthread: edit ${t.path}`,
    content: toB64(markdown),
    sha: sha ?? undefined,
  });

  const pr = await octokit.pulls.create({
    owner: t.owner,
    repo: t.repo,
    head: branch,
    base: t.ref,
    title: opts?.title ?? `DocThread edit: ${t.path}`,
    body:
      opts?.body ??
      `Edited via **DocThread**.\n\nReview comments live in the \`.docthread/\` sidecar and the \`DocThread review: ${t.path}\` issue.`,
  });

  return { url: pr.data.html_url, branch, number: pr.data.number };
}

// ---- localStorage mode (zero-setup default) ----

export function localKey(docPath: string): string {
  return docPath.startsWith('docthread:v2:') ? docPath : `docthread:${docPath}`;
}

export function loadLocal(docPath: string): DocThreadFile | null {
  const raw = localStorage.getItem(localKey(docPath));
  if (!raw) return null;
  try {
    return decodeDocThreadFile(JSON.parse(raw));
  } catch {
    // Corrupt/incompatible localStorage — drop it so it can't blank the app.
    try {
      localStorage.removeItem(localKey(docPath));
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function saveLocal(file: DocThreadFile, storageKey = file.docPath): void {
  localStorage.setItem(localKey(storageKey), JSON.stringify(file));
}

// ---- @mention notifications ----------------------------------------------

function docUrl(t: GitHubTarget): string {
  return docBlobUrl(t);
}

async function findOrCreateReviewIssue(
  token: string,
  t: GitHubTarget,
  title: string,
  expectedViewerNodeId: string
): Promise<number> {
  const repositoryPath = `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;
  // Look for an existing open tracking issue for this document.
  const list = await notificationRequest<Array<{ number: number; title: string; pull_request?: unknown }>>(
    `${repositoryPath}/issues?state=open&per_page=100`,
    {},
    token,
    expectedViewerNodeId
  );
  const existing = list.find((issue) => issue.title === title && !issue.pull_request);
  if (existing) return existing.number;

  const created = await notificationRequest<{ number: number }>(
    `${repositoryPath}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        body:
          `Inline review threads for the [source document](${docUrl(t)}), tracked by **DocThread**.\n\n` +
          `Each comment below notifies the mentioned reviewers. Open the file in DocThread to see the highlights in context.`,
      }),
    },
    token,
    expectedViewerNodeId
  );
  return created.number;
}

async function notificationRequest<T>(
  requestPath: string,
  init: RequestInit,
  token: string,
  expectedViewerNodeId: string
): Promise<T> {
  const base = GH_API_BASE.replace(/\/+$/, '');
  const localProxy = new URL(base, 'http://localhost').pathname.startsWith('/gh-api');
  const response = await fetch(`${base}${requestPath}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(localProxy ? { 'X-DocThread-Viewer-Node-Id': expectedViewerNodeId } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload?.message || `GitHub notification request failed (${response.status}).`
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

/**
 * Notify @mentioned GitHub users about a review comment by posting to a per-document
 * tracking issue. GitHub then sends each mentioned user a real notification.
 * Returns the URL of the created issue comment.
 */
export async function notifyMentions(
  token: string,
  t: GitHubTarget,
  args: { mentions: string[]; expectedViewerNodeId: string }
): Promise<{ url: string; issue: number }> {
  const title = `DocThread review: ${t.path}`;
  const number = await findOrCreateReviewIssue(
    token,
    t,
    title,
    args.expectedViewerNodeId
  );

  const mentionStr = args.mentions.map((u) => `@${u}`).join(' ');
  const commentBody =
    `${mentionStr} — A DocThread reviewer assigned you a review in ` +
    `the [source document](${docUrl(t)}).`;

  const comment = await notificationRequest<{ html_url: string }>(
    `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/issues/${number}/comments`,
    { method: 'POST', body: JSON.stringify({ body: commentBody }) },
    token,
    args.expectedViewerNodeId
  );
  return { url: comment.html_url, issue: number };
}

/** Public GitHub blob URL for a target. */
export function docBlobUrl(t: GitHubTarget): string {
  return githubBlobUrl(t);
}
