import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGitHubTargetDeepLinkParams,
  decodeGitHubTargetDeepLinkParams,
  executePublicGitHubResolutionRequest,
  GitHubSourceResolutionError,
  GitHubTargetDeepLinkError,
  MAX_GITHUB_DEEP_LINK_TARGET_BYTES,
  MAX_PUBLIC_GITHUB_RESOLUTION_PROBES,
  parseGitHubSourceUrl,
  resolveGitHubSourceUrl,
  verifyGitHubSourceTarget,
  type GitHubGraphQLExecutor,
} from '../src/githubSource.ts';
import {
  adoWorkItemDocPath,
  parseGitHubUrl,
  parseAdoWorkItemUrl,
  parseAzureReposUrl,
  parseSourceUrl,
  githubBlobUrl,
  sidecarPath,
  v2SidecarPath,
} from '../src/source.ts';
import type { GitHubSourceTarget, GitHubVersionType } from '../src/types.ts';

const BRANCH_SHA = '1111111111111111111111111111111111111111';
const TAG_SHA = '2222222222222222222222222222222222222222';

interface GraphQLMatch {
  versionType: GitHubVersionType;
  ref: string;
  path: string;
  commitSha: string;
}

function matchingGraphQL(
  matches: readonly GraphQLMatch[],
  onRequest: () => void = () => undefined
): GitHubGraphQLExecutor {
  return async ({ variables }) => {
    onRequest();
    const repository: Record<string, unknown> = {};
    for (let index = 0; index < 64; index += 1) {
      const revision = variables[`revision${index}`];
      const expression = variables[`expression${index}`];
      if (!revision || !expression) break;
      const versionType: GitHubVersionType = revision.startsWith('refs/heads/')
        ? 'branch'
        : revision.startsWith('refs/tags/')
          ? 'tag'
          : 'commit';
      const ref =
        versionType === 'branch'
          ? revision.slice('refs/heads/'.length)
          : versionType === 'tag'
            ? revision.slice('refs/tags/'.length)
            : revision;
      const path = expression.slice(revision.length + 1);
      const match = matches.find(
        (candidate) =>
          candidate.versionType === versionType && candidate.ref === ref && candidate.path === path
      );
      if (!match) continue;
      repository[`probe${index}Revision`] =
        versionType === 'commit'
          ? { __typename: 'Commit', oid: match.commitSha }
          : { target: { __typename: 'Commit', oid: match.commitSha } };
      repository[`probe${index}File`] = { __typename: 'Blob', oid: `blob-${index}` };
    }
    return { data: { repository } };
  };
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

test('returns a provisional GitHub target instead of guessing a ref type', () => {
  assert.deepEqual(
    parseSourceUrl('https://github.com/gim-home/DocThread/blob/main/docs/design.md?plain=1#L12'),
    {
      kind: 'github-provisional',
      owner: 'gim-home',
      repo: 'DocThread',
      boundary: 'ambiguous',
      candidates: [
        { ref: 'main', path: 'docs/design.md' },
        { ref: 'main/docs', path: 'design.md' },
      ],
    }
  );
});

test('resolves an ordinary main blob URL without assuming its ref type', async () => {
  const url = 'https://github.com/gim-home/DocThread/blob/main/README.md';
  assert.deepEqual(parseGitHubUrl(url), {
    kind: 'github-provisional',
    owner: 'gim-home',
    repo: 'DocThread',
    boundary: 'ambiguous',
    candidates: [{ ref: 'main', path: 'README.md' }],
  });

  assert.deepEqual(
    await resolveGitHubSourceUrl(
      url,
      matchingGraphQL([
        {
          versionType: 'branch',
          ref: 'main',
          path: 'README.md',
          commitSha: BRANCH_SHA,
        },
      ])
    ),
    {
      status: 'resolved',
      target: {
        kind: 'github',
        owner: 'gim-home',
        repo: 'DocThread',
        versionType: 'branch',
        ref: 'main',
        path: 'README.md',
        commitSha: BRANCH_SHA,
      },
    }
  );
});

test('decodes an encoded slash once as the complete provisional ref', async () => {
  const url =
    'https://github.com/gim-home/DocThread/blob/feature%2Fdocs/guides/review.md';
  assert.deepEqual(parseGitHubSourceUrl(url)?.candidates, [
    { ref: 'feature/docs', path: 'guides/review.md' },
  ]);
  const resolution = await resolveGitHubSourceUrl(
    url,
    matchingGraphQL([
      {
        versionType: 'branch',
        ref: 'feature/docs',
        path: 'guides/review.md',
        commitSha: BRANCH_SHA,
      },
    ])
  );
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.status === 'resolved' && resolution.target.ref, 'feature/docs');
});

test('keeps a double-encoded slash literal after exactly one decode', async () => {
  const url = 'https://raw.githubusercontent.com/gim-home/DocThread/feature%252Fdocs/README.md';
  assert.deepEqual(parseGitHubSourceUrl(url)?.candidates, [
    { ref: 'feature%2Fdocs', path: 'README.md' },
  ]);
  const resolution = await resolveGitHubSourceUrl(
    url,
    matchingGraphQL([
      {
        versionType: 'branch',
        ref: 'feature%2Fdocs',
        path: 'README.md',
        commitSha: BRANCH_SHA,
      },
    ])
  );
  assert.equal(resolution.status, 'resolved');
});

test('enumerates every unencoded ref/path boundary in one request', async () => {
  const url =
    'https://github.com/gim-home/DocThread/blob/feature/docs/guides/review.md';
  assert.deepEqual(parseGitHubSourceUrl(url)?.candidates, [
    { ref: 'feature', path: 'docs/guides/review.md' },
    { ref: 'feature/docs', path: 'guides/review.md' },
    { ref: 'feature/docs/guides', path: 'review.md' },
  ]);
  let requests = 0;
  const resolution = await resolveGitHubSourceUrl(
    url,
    matchingGraphQL(
      [
        {
          versionType: 'branch',
          ref: 'feature/docs',
          path: 'guides/review.md',
          commitSha: BRANCH_SHA,
        },
      ],
      () => {
        requests += 1;
      }
    )
  );
  assert.equal(requests, 1);
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.status === 'resolved' && resolution.target.ref, 'feature/docs');
});

test('returns branch and tag collisions as distinct verified choices', async () => {
  const matches: GraphQLMatch[] = [
    { versionType: 'branch', ref: 'release', path: 'README.md', commitSha: BRANCH_SHA },
    { versionType: 'tag', ref: 'release', path: 'README.md', commitSha: TAG_SHA },
  ];
  const resolution = await resolveGitHubSourceUrl(
    'https://github.com/gim-home/DocThread/blob/release/README.md',
    matchingGraphQL(matches)
  );
  assert.equal(resolution.status, 'ambiguous');
  assert.deepEqual(
    resolution.status === 'ambiguous'
      ? resolution.candidates.map(({ versionType, ref, path, commitSha }) => ({
          versionType,
          ref,
          path,
          commitSha,
        }))
      : [],
    matches
  );
});

test('verifies a canonical target against its exact selected ref type', async () => {
  const target: GitHubSourceTarget = {
    kind: 'github',
    owner: 'gim-home',
    repo: 'DocThread',
    versionType: 'tag',
    ref: 'release',
    path: 'README.md',
  };
  const verified = await verifyGitHubSourceTarget(
    target,
    matchingGraphQL([
      { versionType: 'branch', ref: 'release', path: 'README.md', commitSha: BRANCH_SHA },
      { versionType: 'tag', ref: 'release', path: 'README.md', commitSha: TAG_SHA },
    ])
  );
  assert.deepEqual(verified, { ...target, commitSha: TAG_SHA });
});

test('accepts an exact 40-hex commit candidate only when the path is a blob', async () => {
  const commitSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const resolution = await resolveGitHubSourceUrl(
    `https://github.com/gim-home/DocThread/blob/${commitSha}/README.md`,
    matchingGraphQL([
      { versionType: 'commit', ref: commitSha, path: 'README.md', commitSha },
    ])
  );
  assert.equal(resolution.status, 'resolved');
  assert.deepEqual(
    resolution.status === 'resolved'
      ? {
          versionType: resolution.target.versionType,
          ref: resolution.target.ref,
          commitSha: resolution.target.commitSha,
        }
      : null,
    { versionType: 'commit', ref: commitSha, commitSha }
  );
});

test('rejects candidate expansion before network access and returns typed zero-match errors', async () => {
  const overCandidateLimit = Array.from({ length: 34 }, (_, index) => `segment-${index}`).join('/');
  let requests = 0;
  await assert.rejects(
    resolveGitHubSourceUrl(
      `https://github.com/gim-home/DocThread/blob/${overCandidateLimit}`,
      matchingGraphQL([], () => {
        requests += 1;
      })
    ),
    (error) => error instanceof GitHubSourceResolutionError && error.code === 'candidate-limit'
  );
  assert.equal(requests, 0);

  const overTailLimit = Array.from({ length: 65 }, (_, index) => `segment-${index}`).join('/');
  assert.equal(
    parseGitHubSourceUrl(`https://github.com/gim-home/DocThread/blob/${overTailLimit}`),
    null
  );

  await assert.rejects(
    resolveGitHubSourceUrl(
      'https://github.com/gim-home/DocThread/blob/main/missing.md',
      matchingGraphQL([])
    ),
    (error) => error instanceof GitHubSourceResolutionError && error.code === 'no-match'
  );
});

test('rejects encoded slashes in file path segments', async () => {
  const url = 'https://github.com/gim-home/DocThread/blob/main/docs%2Fguide/readme.md';
  assert.equal(parseGitHubSourceUrl(url), null);
  await assert.rejects(
    resolveGitHubSourceUrl(url, matchingGraphQL([])),
    (error) => error instanceof GitHubSourceResolutionError && error.code === 'invalid-url'
  );
});

test('round-trips canonical branch and commit deep-link targets', () => {
  const targets: GitHubSourceTarget[] = [
    {
      kind: 'github',
      owner: 'gim-home',
      repo: 'DocThread',
      versionType: 'branch',
      ref: 'feature/docs',
      path: 'guides/review notes.md',
    },
    {
      kind: 'github',
      owner: 'gim-home',
      repo: 'DocThread',
      versionType: 'commit',
      ref: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD',
      path: 'README.md',
    },
  ];
  for (const target of targets) {
    const params = buildGitHubTargetDeepLinkParams(target);
    assert.match(params, /^targetVersion=1&target=[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeGitHubTargetDeepLinkParams(params), {
      ...target,
      ref: target.versionType === 'commit' ? target.ref.toLowerCase() : target.ref,
    });
  }
});

test('rejects tampered deep-link shapes and oversized canonical targets', () => {
  const tampered = base64UrlJson({
    kind: 'github',
    owner: 'gim-home',
    repo: 'DocThread',
    versionType: 'branch',
    ref: 'main',
    path: 'README.md',
    writable: true,
  });
  assert.throws(
    () => decodeGitHubTargetDeepLinkParams(`targetVersion=1&target=${tampered}`),
    (error) => error instanceof GitHubTargetDeepLinkError && error.code === 'invalid-target'
  );
  assert.throws(
    () =>
      buildGitHubTargetDeepLinkParams({
        kind: 'github',
        owner: 'gim-home',
        repo: 'DocThread',
        versionType: 'branch',
        ref: 'main',
        path: `${'a'.repeat(MAX_GITHUB_DEEP_LINK_TARGET_BYTES)}.md`,
      }),
    (error) => error instanceof GitHubTargetDeepLinkError && error.code === 'target-too-large'
  );
});

test('parses a canonical Azure Repos branch URL', () => {
  assert.deepEqual(
    parseAzureReposUrl(
      'https://dev.azure.com/fabrikam/Docs/_git/handbook?path=%2Fguides%2Freview.md&version=GBfeature%2Fcomments&_a=contents'
    ),
    {
      kind: 'azure-repos',
      organization: 'fabrikam',
      project: 'Docs',
      repo: 'handbook',
      path: 'guides/review.md',
      ref: 'feature/comments',
      versionType: 'branch',
    }
  );
});

test('parses a legacy Azure Repos commit URL', () => {
  assert.deepEqual(
    parseSourceUrl(
      'https://fabrikam.visualstudio.com/Docs/_git/handbook?path=/README.md&version=GCabc123'
    ),
    {
      kind: 'azure-repos',
      organization: 'fabrikam',
      project: 'Docs',
      repo: 'handbook',
      path: 'README.md',
      ref: 'abc123',
      versionType: 'commit',
    }
  );
});

test('parses Azure DevOps work item URLs as a third provider', () => {
  const target = {
    kind: 'ado-workitem' as const,
    organization: 'fabrikam',
    project: 'Docs Project',
    id: 42,
  };
  assert.deepEqual(
    parseAdoWorkItemUrl(
      'https://dev.azure.com/fabrikam/Docs%20Project/_workitems/edit/42?view=discussion'
    ),
    target
  );
  assert.deepEqual(
    parseSourceUrl('https://fabrikam.visualstudio.com/Docs%20Project/_workitems/edit/42'),
    target
  );
  assert.equal(adoWorkItemDocPath(target), 'ado:fabrikam/Docs Project/42');
});

test('keeps legacy Git paths readable and uses collision-safe v2 paths', () => {
  assert.equal(
    sidecarPath('docs/design.md'),
    '.docthread/docs__design.md.json'
  );
  assert.equal(
    v2SidecarPath('docs/design.md'),
    '.docthread/v2/docs/design.md.json'
  );
  assert.equal(parseSourceUrl('https://dev.azure.com/fabrikam/Docs/_git/handbook'), null);
});

test('resolves a public GitHub file without GraphQL authentication', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/git/ref/heads/main')) {
      return Response.json({ object: { type: 'commit', sha: BRANCH_SHA } });
    }
    if (url.includes('/git/ref/tags/')) return new Response('Not Found', { status: 404 });
    if (url.includes('/contents/README.md')) {
      return Response.json({ type: 'file', sha: 'blob-readme' });
    }
    return new Response('Not Found', { status: 404 });
  };
  const resolution = await resolveGitHubSourceUrl(
    'https://github.com/gim-home/DocThread/blob/main/README.md',
    (request) => executePublicGitHubResolutionRequest(request, fetchImpl)
  );
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.status === 'resolved' && resolution.target.versionType, 'branch');
  assert.equal(resolution.status === 'resolved' && resolution.target.commitSha, BRANCH_SHA);
  assert.ok(requests.some((url) => url.includes('/git/ref/heads/main')));
  assert.ok(requests.some((url) => url.includes(`/contents/README.md?ref=${BRANCH_SHA}`)));
});

test('strictly encodes repository-controlled GitHub link text and delimiters', () => {
  const url = githubBlobUrl({
    owner: 'contoso',
    repo: 'docs',
    ref: 'feature/(review)',
    path: 'docs/x`](#x) @unverified [`y.md',
  });
  assert.equal(
    url,
    'https://github.com/contoso/docs/blob/feature%2F%28review%29/docs/x%60%5D%28%23x%29%20%40unverified%20%5B%60y.md'
  );
  assert.doesNotMatch(url, /[\[\]()` ]/);
});

test('public-only resolution rejects excess probes before spending REST requests', async () => {
  let requests = 0;
  const variables: Record<string, string> = { owner: 'contoso', repo: 'docs' };
  for (let index = 0; index <= MAX_PUBLIC_GITHUB_RESOLUTION_PROBES; index += 1) {
    variables[`revision${index}`] = `refs/heads/branch-${index}`;
    variables[`expression${index}`] = `refs/heads/branch-${index}:README.md`;
  }
  await assert.rejects(
    executePublicGitHubResolutionRequest(
      { query: 'query', variables },
      async () => {
        requests += 1;
        return new Response('Not Found', { status: 404 });
      }
    ),
    (error) => error instanceof GitHubSourceResolutionError && error.code === 'candidate-limit'
  );
  assert.equal(requests, 0);
});