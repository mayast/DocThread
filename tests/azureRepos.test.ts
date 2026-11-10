import assert from 'node:assert/strict';
import test from 'node:test';

import {
  azureReposFileUrl,
  azureReposItemPath,
  buildAzureReposPush,
  writableAzureReposBranch,
} from '../src/azureReposApi.ts';
import { AzureReposError, createAzureReposClient } from '../src/azureRepos.ts';
import type { AzureReposTarget } from '../src/source.ts';

const target: AzureReposTarget = {
  kind: 'azure-repos',
  organization: 'fabrikam',
  project: 'Docs Project',
  repo: 'handbook',
  path: 'guides/review notes.md',
  ref: 'feature/comments',
  versionType: 'branch',
};

test('builds an Azure Repos item request with an explicit version descriptor', () => {
  const request = new URL(azureReposItemPath(target), 'https://dev.azure.com');
  assert.equal(
    request.pathname,
    '/fabrikam/Docs%20Project/_apis/git/repositories/handbook/items'
  );
  assert.equal(request.searchParams.get('path'), '/guides/review notes.md');
  assert.equal(request.searchParams.get('versionDescriptor.version'), 'feature/comments');
  assert.equal(request.searchParams.get('versionDescriptor.versionType'), 'branch');
  assert.equal(request.searchParams.get('includeContent'), 'true');
  assert.equal(request.searchParams.get('api-version'), '7.1');
});

test('builds an optimistic add or edit push against the current branch tip', () => {
  const add = buildAzureReposPush(
    'main',
    'abc123',
    '.docthread/docs__review.md.json',
    '{"threads":[]}',
    false,
    'docthread: add review'
  );
  assert.deepEqual(add.refUpdates, [{ name: 'refs/heads/main', oldObjectId: 'abc123' }]);
  assert.equal(add.commits[0].changes[0].changeType, 'add');
  assert.equal(add.commits[0].changes[0].item.path, '/.docthread/docs__review.md.json');
  assert.equal(add.commits[0].changes[0].newContent.contentType, 'rawtext');

  const edit = buildAzureReposPush('main', 'def456', '/README.md', '# Updated', true, 'edit');
  assert.equal(edit.commits[0].changes[0].changeType, 'edit');
  assert.equal(edit.commits[0].changes[0].item.path, '/README.md');
});

test('allows writes only to explicit branch URLs', () => {
  assert.equal(writableAzureReposBranch(target), 'feature/comments');
  assert.throws(
    () => writableAzureReposBranch({ ...target, ref: 'abc123', versionType: 'commit' }),
    /pinned to a branch/
  );
  assert.throws(() => writableAzureReposBranch({ ...target, ref: null }), /pinned to a branch/);
});

test('builds a canonical Azure Repos source URL', () => {
  const url = new URL(azureReposFileUrl(target));
  assert.equal(url.hostname, 'dev.azure.com');
  assert.equal(url.pathname, '/fabrikam/Docs%20Project/_git/handbook');
  assert.equal(url.searchParams.get('path'), '/guides/review notes.md');
  assert.equal(url.searchParams.get('version'), 'GBfeature/comments');
});

test('loads Markdown pinned to the supplied Azure Repos branch head', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = createAzureReposClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ content: '# Review', objectId: 'blob123' });
    },
  });

  assert.deepEqual(await client.fetchMarkdown(target, 'tip123'), {
    text: '# Review',
    revision: 'tip123',
  });
  assert.match(requests[0].url, /includeContent=true/);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('versionDescriptor.version'), 'tip123');
  assert.equal(url.searchParams.get('versionDescriptor.versionType'), 'commit');
});

test('saves a v2 sidecar against the supplied branch head without a hidden ref lookup', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = createAzureReposClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ commits: [{ commitId: 'commit456' }] });
    },
  });

  const revision = await client.saveSidecar(
    target,
    {
      schemaVersion: 2,
      source: { provider: 'azure-repos', path: target.path },
      docPath: target.path,
      threads: [],
      updatedAt: '2026-08-21T00:00:00Z',
    },
    'tip123',
    false
  );
  assert.equal(revision, 'commit456');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/pushes\?/);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body.refUpdates, [
    { name: 'refs/heads/feature/comments', oldObjectId: 'tip123' },
  ]);
  assert.equal(body.commits[0].changes[0].changeType, 'add');
  assert.equal(
    body.commits[0].changes[0].item.path,
    '/.docthread/v2/guides/review%20notes.md.json'
  );
});

test('classifies a 203 HTML sign-in page before parsing an Azure Repos item', async () => {
  const client = createAzureReposClient({
    fetch: async () =>
      new Response('<!doctype html><title>Sign in</title>', {
        status: 203,
        headers: { 'Content-Type': 'text/html' },
      }),
  });
  await assert.rejects(
    client.fetchMarkdown(target),
    (error) =>
      error instanceof AzureReposError &&
      error.kind === 'signin-required' &&
      error.status === 203
  );
});

test('resolves an omitted Azure Repos version to the provider default branch', async () => {
  let requestUrl = '';
  const client = createAzureReposClient({
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json({ defaultBranch: 'refs/heads/trunk' });
    },
  });
  const resolved = await client.resolveTarget({ ...target, ref: null });
  assert.equal(resolved.ref, 'trunk');
  assert.equal(resolved.versionType, 'branch');
  assert.match(requestUrl, /_apis\/git\/repositories\/handbook\?api-version=7\.1/);
});

test('commits a document against the loaded branch head without fetching a newer tip', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = createAzureReposClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ commits: [{ commitId: 'commit789' }] });
    },
  });
  assert.equal(await client.commitDocument(target, '# Updated', 'tip123'), 'commit789');
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body.refUpdates, [
    { name: 'refs/heads/feature/comments', oldObjectId: 'tip123' },
  ]);
  assert.equal(body.commits[0].changes[0].item.path, '/guides/review notes.md');
});

test('creates a PR branch from the exact loaded target commit', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses = [
    Response.json({ commits: [{ commitId: 'branch-commit' }] }),
    Response.json({ pullRequestId: 17 }),
  ];
  const client = createAzureReposClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return responses.shift()!;
    },
  });
  const pullRequest = await client.createDocumentPullRequest(
    target,
    '# Proposed',
    'tip123'
  );
  assert.equal(pullRequest.number, 17);
  const push = JSON.parse(String(requests[0].init?.body));
  assert.equal(push.refUpdates[0].oldObjectId, '0000000000000000000000000000000000000000');
  assert.deepEqual(push.commits[0].parents, ['tip123']);
  assert.match(push.refUpdates[0].name, /^refs\/heads\/docthread\/edit-/);
});