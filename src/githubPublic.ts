import type { GitHubTarget } from './types.ts';
import { githubRawUrl } from './source.ts';

export interface PublicGitHubText {
  text: string;
  etag: string | null;
}

export class PublicGitHubFileError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PublicGitHubFileError';
    this.status = status;
  }
}

export async function fetchPublicGitHubText(
  target: GitHubTarget,
  path = target.path,
  fetchImpl: typeof fetch = fetch
): Promise<PublicGitHubText | null> {
  const response = await fetchImpl(githubRawUrl(target, path), {
    cache: 'no-cache',
    headers: { Accept: 'text/plain' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const suffix =
      response.status === 401 || response.status === 403
        ? ' Configure hosted GitHub sign-in for private repositories.'
        : '';
    throw new PublicGitHubFileError(
      `Public GitHub file request failed (${response.status}).${suffix}`,
      response.status
    );
  }
  return { text: await response.text(), etag: response.headers.get('etag') };
}