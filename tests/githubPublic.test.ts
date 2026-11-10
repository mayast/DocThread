import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPublicGitHubText, PublicGitHubFileError } from '../src/githubPublic.ts';
import { githubRawUrl } from '../src/source.ts';
import type { GitHubTarget } from '../src/types.ts';

const target: GitHubTarget = {
  owner: 'microsoft',
  repo: 'Type Script',
  ref: 'main',
  path: 'docs/review notes.md',
};

test('builds an encoded raw GitHub URL without using the REST API', () => {
  assert.equal(
    githubRawUrl(target),
    'https://raw.githubusercontent.com/microsoft/Type%20Script/main/docs/review%20notes.md'
  );
});

test('loads public GitHub text and treats a missing optional file as absent', async () => {
  const requests: string[] = [];
  const loaded = await fetchPublicGitHubText(target, target.path, async (input) => {
    requests.push(String(input));
    return new Response('# Review', { status: 200, headers: { etag: 'public-etag' } });
  });
  assert.deepEqual(loaded, { text: '# Review', etag: 'public-etag' });
  assert.match(requests[0], /^https:\/\/raw\.githubusercontent\.com\//);

  const missing = await fetchPublicGitHubText(
    target,
    '.docthread/docs__review.md.json',
    async () => new Response('Not Found', { status: 404 })
  );
  assert.equal(missing, null);
});

test('explains when public raw access cannot replace authenticated GitHub access', async () => {
  await assert.rejects(
    fetchPublicGitHubText(target, target.path, async () => new Response('Forbidden', { status: 403 })),
    (error) =>
      error instanceof PublicGitHubFileError &&
      error.status === 403 &&
      /Configure hosted GitHub sign-in/.test(error.message)
  );
});