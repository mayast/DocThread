import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildGitHubRequestPreview,
  assignGitHubReviewIssueReviewers,
  createGitHubReviewIssue,
  createGitHubReviewPullRequest,
  defaultRequestReviewDraft,
  discoverActiveGitHubReviewIssue,
  findActiveGitHubIssueDuplicate,
  formatReviewRequestStatus,
  githubIssueDuplicateKey,
  makeGitHubReviewRecord,
  makeUnknownGitHubIssueRecord,
  mapGitHubIssueStatus,
  loadReviewRequestRecords,
  mergeReviewRequestRecords,
  normalizeRequestReviewDraftChannel,
  parseReviewerHandles,
  parseReviewRequestRecords,
  reconcileUnknownGitHubReviewIssue,
  refreshGitHubReviewIssueStatus,
  requestReviewEligibility,
  RequestReviewProviderError,
  upsertReviewRequestRecord,
  validateGitHubRequestPreview,
  type ReviewRequestRecord,
} from '../src/requestReview.ts';
import type { SourceTarget } from '../src/source.ts';

const githubTarget: Extract<SourceTarget, { kind: 'github' }> = {
  kind: 'github',
  owner: 'Contoso',
  repo: 'Docs',
  versionType: 'branch',
  ref: 'main',
  path: 'PRDs/Request.md',
};

function expectedDuplicateKey() {
  const material = JSON.stringify(['github-issue-v2', 'contoso', 'docs', githubTarget.path, 'branch', 'main']);
  return `github-issue:v2:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function preview(records: ReviewRequestRecord[] = []) {
  return buildGitHubRequestPreview({
    target: githubTarget,
    sourceKey: 'source-key',
    draft: {
      ...defaultRequestReviewDraft(githubTarget, 'Request Review PRD', '2026-09-15T00:00:00.000Z'),
      reviewersText: '@Octocat, hubot octocat',
      scope: 'Review acceptance criteria',
      instructions: 'Focus on issue-based request flow.',
      targetBranch: '',
    },
    records,
    appUrl: 'https://app.example/',
    docThreadLink: 'https://app.example/?target=abc',
  });
}

test('GitHub channel is labeled exactly GitHub review issue and later channels stay gated', () => {
  const channels = requestReviewEligibility(githubTarget, { github: true, azure: false });
  assert.equal(channels.length, 3);
  assert.equal(channels[0].channel, 'github-issue');
  assert.equal(channels[0].label, 'GitHub review issue');
  assert.equal(channels[0].artifact, 'Issue');
  assert.equal(channels[0].available, true);
  assert.equal(channels[1].available, false);
  assert.match(channels[1].gatedReason || '', /Phase 2/);
  assert.equal(channels[2].available, false);
});

test('GitHub channel explains missing source and auth prerequisites', () => {
  const [channel] = requestReviewEligibility(null, { github: false, azure: false });
  assert.equal(channel.available, false);
  assert.deepEqual(channel.missing, ['Open a repository-backed document.', 'Sign in with GitHub.']);
});

test('preview validation does not require a target branch', () => {
  const result = preview();
  assert.equal(result.targetBranch, undefined);
  assert.deepEqual(result.reviewers, ['Octocat', 'hubot']);
  assert.deepEqual(validateGitHubRequestPreview(result), []);
});

test('legacy saved GitHub PR drafts reopen as the GitHub Issue channel', () => {
  assert.equal(normalizeRequestReviewDraftChannel('github-pr'), 'github-issue');
  assert.equal(normalizeRequestReviewDraftChannel('github-issue'), 'github-issue');
  assert.equal(normalizeRequestReviewDraftChannel('azure-repos-pr'), 'azure-repos-pr');
  assert.equal(normalizeRequestReviewDraftChannel('ado-work-item'), 'ado-work-item');
  assert.equal(normalizeRequestReviewDraftChannel('unexpected'), 'github-issue');
});

test('issue body includes links, scope, instructions, reviewer mentions and deterministic marker', () => {
  const result = preview();
  assert.equal(result.duplicateKey, expectedDuplicateKey());
  assert.equal(githubIssueDuplicateKey(githubTarget), expectedDuplicateKey());
  assert.match(result.body, /Requested via \*\*DocThread\*\*/);
  assert.match(result.body, /DocThread review: https:\/\/app\.example\/\?target=abc/);
  assert.match(result.body, /Source document: https:\/\/github\.com\/Contoso\/Docs\/blob\/main\/PRDs\/Request\.md/);
  assert.match(result.body, /Requested reviewers: @Octocat @hubot/);
  assert.match(result.body, /## Review scope\nReview acceptance criteria/);
  assert.match(result.body, /## Instructions\nFocus on issue-based request flow\./);
  assert.match(result.body, new RegExp(`<!-- docthread-review-key:${expectedDuplicateKey()} -->`));
});

test('duplicate identity folds repository casing but preserves document, ref casing and version type', () => {
  const base = githubIssueDuplicateKey(githubTarget);
  assert.equal(
    githubIssueDuplicateKey({ ...githubTarget, owner: 'contoso', repo: 'docs' }),
    base
  );
  assert.notEqual(githubIssueDuplicateKey({ ...githubTarget, path: 'prds/request.md' }), base);
  // Previously pinned ref exclusion; the agreed identity is document + exact typed ref.
  assert.notEqual(githubIssueDuplicateKey({ ...githubTarget, ref: 'feature/other' }), base);
  assert.notEqual(githubIssueDuplicateKey({ ...githubTarget, ref: 'Main' }), base);
  assert.notEqual(githubIssueDuplicateKey({ ...githubTarget, versionType: 'tag' }), base);
});

test('active issue duplicates block while legacy PR records do not', () => {
  const active = makeGitHubReviewRecord({
    id: 'rr-1',
    sourceKey: 'source-key',
    sourceBranch: githubTarget.ref,
    preview: preview(),
    externalId: '9001',
    externalNumber: 12,
    externalUrl: 'https://github.com/contoso/docs/issues/12',
    nowIso: '2026-09-15T00:00:00.000Z',
  });
  const legacyPr: ReviewRequestRecord = {
    ...active,
    id: 'legacy-pr',
    channel: 'github-pr',
    duplicateKey: 'github-pr|source-key|main',
  };
  // Previously treated local status as closure; only GitHub closure releases identity.
  const closed = { ...active, id: 'closed', status: 'closed' as const, providerState: 'closed' as const };
  assert.equal(findActiveGitHubIssueDuplicate([legacyPr, closed], githubTarget), undefined);
  assert.equal(findActiveGitHubIssueDuplicate([active], githubTarget)?.id, 'rr-1');
});

test('records round-trip while malformed storage entries are ignored', () => {
  const record = makeGitHubReviewRecord({
    id: 'rr-1',
    sourceKey: 'source-key',
    sourceBranch: githubTarget.ref,
    preview: preview(),
    externalId: '9001',
    externalNumber: 12,
    externalUrl: 'https://github.com/contoso/docs/issues/12',
    nowIso: '2026-09-15T00:00:00.000Z',
  });
  // The issue summary now reports provider state instead of a local process stage.
  assert.equal(formatReviewRequestStatus(record), 'Open');
  assert.deepEqual(upsertReviewRequestRecord([{ ...record, title: 'old' }], record), [record]);
  assert.deepEqual(parseReviewRequestRecords(JSON.stringify([record, { bad: true }]))[0], record);
});

test('reviewer handles dedupe case-insensitively and invalid handles fail validation', () => {
  assert.deepEqual(parseReviewerHandles('@Octocat, octocat hubot mayast_microsoft'), ['Octocat', 'hubot', 'mayast_microsoft']);
  const bad = buildGitHubRequestPreview({
    target: githubTarget,
    sourceKey: 'source-key',
    draft: {
      ...defaultRequestReviewDraft(githubTarget, 'Doc', '2026-09-15T00:00:00.000Z'),
      reviewersText: 'org/team bad--handle -start end-',
      instructions: 'Please review.',
    },
    records: [],
    appUrl: 'https://app.example/',
    docThreadLink: 'https://app.example/',
  });
  assert.deepEqual(validateGitHubRequestPreview(bad), [
    'GitHub teams are not supported as issue reviewers: org/team.',
    'Invalid GitHub user handle: bad--handle.',
    'Invalid GitHub user handle: -start.',
    'Invalid GitHub user handle: end-.',
  ]);
});

test('issue creation sends assignees in the native GitHub Issue field and never checks branch diff', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/issues') && method === 'POST') {
      return Response.json({
        id: 9001,
        number: 12,
        html_url: 'https://github.com/contoso/docs/issues/12',
        state: 'open',
        assignees: [{ login: 'Octocat' }],
      });
    }
    if (url.includes('/issues?')) return Response.json([]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await createGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, {
    title: 'Review request',
    body: 'body',
    reviewers: ['Octocat'],
  });

  assert.deepEqual(result, {
    url: 'https://github.com/contoso/docs/issues/12',
    number: 12,
    id: '9001',
    state: 'open',
    confirmedAssignees: ['Octocat'],
  });
  // Creation now requires an authoritative, all-author discovery read first.
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST']);
  assert.deepEqual(requests[1].body, { title: 'Review request', body: 'body', assignees: ['Octocat'] });
  assert.equal(requests.some((request) => request.url.includes('/compare/')), false);
  assert.equal(requests.some((request) => request.url.includes('/pulls')), false);
});

test('issue creation verifies assignees and patches any GitHub silently drops', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/issues') && method === 'POST') {
      return Response.json({
        id: 9001,
        number: 12,
        html_url: 'https://github.com/contoso/docs/issues/12',
        state: 'open',
        assignees: [],
      });
    }
    if (url.endsWith('/issues/12/assignees')) {
      return Response.json({ assignees: [{ login: 'mayast_microsoft' }] });
    }
    if (url.includes('/issues?')) return Response.json([]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await createGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, {
    title: 'Review request',
    body: 'body',
    reviewers: ['mayast_microsoft'],
  });

  assert.equal(result.reviewerAssignmentWarning, undefined);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST', 'POST']);
  assert.deepEqual(requests[1].body, { title: 'Review request', body: 'body', assignees: ['mayast_microsoft'] });
  assert.deepEqual(requests[2].body, { assignees: ['mayast_microsoft'] });
});

test('assignee rejection falls back to creating the issue and returns a warning', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/issues') && init?.method === 'POST' && body.assignees) {
      return Response.json({ message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'assignees', code: 'invalid' }] }, { status: 422 });
    }
    if (url.endsWith('/issues') && init?.method === 'POST') {
      return Response.json({ id: 9002, number: 13, html_url: 'https://github.com/contoso/docs/issues/13', state: 'open' });
    }
    if (url.endsWith('/issues/13/assignees')) {
      return Response.json({ message: 'Validation Failed' }, { status: 422 });
    }
    if (url.includes('/issues?')) return Response.json([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await createGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, {
    title: 'Review request',
    body: 'body',
    reviewers: ['missing-user'],
  });
  assert.equal(result.number, 13);
  assert.equal(result.url, 'https://github.com/contoso/docs/issues/13');
  assert.match(result.reviewerAssignmentWarning || '', /Validation Failed/);
});

test('unknown create outcome is surfaced for reconciliation without automatic retry', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (!init?.method || init.method === 'GET') return Response.json([]);
    calls += 1;
    throw new Error('connection reset');
  };
  await assert.rejects(
    createGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, {
      title: 'Review request',
      body: 'body',
      reviewers: [],
    }),
    (error) => error instanceof RequestReviewProviderError && error.category === 'unknown-outcome'
  );
  assert.equal(calls, 1);
});

test('unknown outcome reconciliation records one marker match and ignores pull requests', async () => {
  const key = expectedDuplicateKey();
  const fetchImpl: typeof fetch = async () =>
    Response.json([
      { id: 1, number: 1, html_url: 'https://github.com/contoso/docs/pull/1', state: 'open', pull_request: {}, body: `<!-- docthread-review-key:${key} -->` },
      { id: 2, number: 2, html_url: 'https://github.com/contoso/docs/issues/2', state: 'open', body: `body\n<!-- docthread-review-key:${key} -->` },
    ]);
  const result = await reconcileUnknownGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, 'mayast', key);
  assert.equal(result?.number, 2);
  assert.equal(result?.duplicate, true);
});

test('multiple reconciliation matches block creation and failed reconciliation preserves unknown records', async () => {
  const unknown = makeUnknownGitHubIssueRecord({
    id: 'rr-unknown',
    sourceKey: 'source-key',
    sourceBranch: githubTarget.ref,
    preview: preview(),
    nowIso: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(unknown.status, 'unknown');

  const key = expectedDuplicateKey();
  const fetchImpl: typeof fetch = async () =>
    Response.json([
      { id: 2, number: 2, html_url: 'https://github.com/contoso/docs/issues/2', state: 'open', body: `<!-- docthread-review-key:${key} -->` },
      { id: 3, number: 3, html_url: 'https://github.com/contoso/docs/issues/3', state: 'open', body: `<!-- docthread-review-key:${key} -->` },
    ]);
  await assert.rejects(
    reconcileUnknownGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, 'mayast', key),
    /Multiple GitHub issues/
  );
});

test('status refresh accepts only Issue responses and maps open, closed, stale, and unknown states', async () => {
  assert.equal(mapGitHubIssueStatus('open'), 'requested');
  assert.equal(mapGitHubIssueStatus('closed'), 'closed');
  const openFetch: typeof fetch = async () =>
    Response.json({ id: 12, number: 12, html_url: 'https://github.com/contoso/docs/issues/12', state: 'open' });
  assert.equal((await refreshGitHubReviewIssueStatus(openFetch, 'https://api.github.com', 'token', githubTarget, 12)).state, 'open');

  const closedFetch: typeof fetch = async () =>
    Response.json({ id: 12, number: 12, html_url: 'https://github.com/contoso/docs/issues/12', state: 'closed' });
  assert.equal((await refreshGitHubReviewIssueStatus(closedFetch, 'https://api.github.com', 'token', githubTarget, 12)).state, 'closed');

  const prFetch: typeof fetch = async () =>
    Response.json({ id: 12, number: 12, html_url: 'https://github.com/contoso/docs/pull/12', state: 'open', pull_request: {} });
  await assert.rejects(
    refreshGitHubReviewIssueStatus(prFetch, 'https://api.github.com', 'token', githubTarget, 12),
    /not an issue/
  );
});

test('preview and cancel produce no GitHub write', () => {
  const result = preview();
  assert.match(result.body, /DocThread review/);
  assert.equal(result.duplicate, undefined);
});

test('existing issue assignee additions retain other assignees and disclose unconfirmed handles', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const result = await assignGitHubReviewIssueReviewers(async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    assert.equal(init?.method, 'POST');
    return Response.json({ assignees: [{ login: 'existing' }, { login: 'mayast_microsoft' }] });
  }, 'https://api.github.com', 'token', githubTarget, 139, ['mayast_microsoft']);
  assert.equal(result.reviewerAssignmentWarning, undefined);
  assert.deepEqual(result.confirmedAssignees, ['existing', 'mayast_microsoft']);
  assert.equal(requests[0].url, 'https://api.github.com/repos/Contoso/Docs/issues/139/assignees');
  assert.deepEqual(requests[0].body, { assignees: ['mayast_microsoft'] });
  const dropped = await assignGitHubReviewIssueReviewers(async () => Response.json({ assignees: [] }),
    'https://api.github.com', 'token', githubTarget, 139, ['mayast_microsoft']);
  assert.match(dropped.reviewerAssignmentWarning ?? '', /did not confirm/);
  assert.deepEqual(dropped.confirmedAssignees, []);
});

const issue = (number = 12, body = preview().body) => ({
  id: number + 1000, number, html_url: `https://github.com/contoso/docs/issues/${number}`,
  state: 'open', assignees: [], body,
});
const createInput = () => ({ title: 'Review request', body: preview().body, reviewers: ['Octocat'] });

test('follow-up assignment success with dropped assignees keeps confirmed issue and warning', async () => {
  let writes = 0;
  const result = await createGitHubReviewIssue(async (input, init) => {
    if (String(input).includes('/issues?')) return Response.json([]);
    writes++;
    assert.equal(init?.method, 'POST');
    return Response.json(String(input).endsWith('/assignees') ? { assignees: [] } : issue());
  }, 'https://api.github.com', 'token', githubTarget, createInput());
  assert.equal(result.number, 12);
  assert.match(result.reviewerAssignmentWarning ?? '', /did not confirm.*@Octocat/);
  assert.deepEqual(result.confirmedAssignees, []);
  assert.equal(writes, 2);
});

test('unreadable, missing-identifier, and 5xx creates are uncertain with exactly one issue POST', async () => {
  for (const response of [
    () => new Response('not JSON', { status: 201 }),
    () => Response.json({ state: 'open' }, { status: 201 }),
    () => Response.json(null, { status: 201 }),
    () => Response.json({ message: 'upstream failed' }, { status: 503 }),
    () => new Response('upstream failed', { status: 502 }),
  ]) {
    let writes = 0;
    await assert.rejects(createGitHubReviewIssue(async (input, init) => {
      if (String(input).includes('/issues?')) return Response.json([]);
      assert.equal(init?.method, 'POST');
      writes++;
      return response();
    }, 'https://api.github.com', 'token', githubTarget, createInput()),
    error => error instanceof RequestReviewProviderError && error.category === 'unknown-outcome');
    assert.equal(writes, 1);
  }
});

test('malformed assignment entries cannot discard a confirmed creation receipt', async () => {
  let writes = 0;
  const result = await createGitHubReviewIssue(async (input, init) => {
    if (String(input).includes('/issues?')) return Response.json([]);
    writes++;
    assert.equal(init?.method, 'POST');
    return Response.json(String(input).endsWith('/assignees')
      ? { assignees: [null] } : { ...issue(), assignees: [null] });
  }, 'https://api.github.com', 'token', githubTarget, createInput());
  assert.equal(result.number, 12);
  assert.match(result.reviewerAssignmentWarning ?? '', /did not confirm.*@Octocat/);
  assert.deepEqual(result.confirmedAssignees, []);
  assert.equal(writes, 2);
});

test('follow-up response verifies the complete requested set, not only added names', async () => {
  const result = await createGitHubReviewIssue(async input => {
    if (String(input).includes('/issues?')) return Response.json([]);
    return Response.json(String(input).endsWith('/assignees')
      ? { assignees: [{ login: 'second' }] } : { ...issue(), assignees: [{ login: 'Octocat' }] });
  }, 'https://api.github.com', 'token', githubTarget, { ...createInput(), reviewers: ['Octocat', 'second'] });
  assert.equal(result.number, 12);
  assert.deepEqual(result.confirmedAssignees, ['second']);
  assert.match(result.reviewerAssignmentWarning ?? '', /did not confirm.*@Octocat/);
});

test('generic and mixed 422 validation errors never retry issue creation', async () => {
  for (const errors of [undefined, [{ resource: 'Issue', field: 'title', code: 'missing' }],
    [{ resource: 'Issue', field: 'assignees', code: 'invalid' }, { resource: 'Issue', field: 'body', code: 'invalid' }]]) {
    let writes = 0;
    await assert.rejects(createGitHubReviewIssue(async (input) => {
      if (String(input).includes('/issues?')) return Response.json([]);
      writes++;
      return Response.json({ message: 'Validation Failed', errors }, { status: 422 });
    }, 'https://api.github.com', 'token', githubTarget, createInput()),
    error => error instanceof RequestReviewProviderError && error.category === 'provider-validation');
    assert.equal(writes, 1);
  }
});

test('provider discovery prevents cross-browser and cross-author duplicate creation on repeated requests', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.notEqual(init?.method, 'POST');
    assert.equal(new URL(String(input)).searchParams.get('creator'), null);
    assert.equal(new URL(String(input)).searchParams.get('state'), 'open');
    return Response.json([{ ...issue(), user: { login: 'someone-else' } }]);
  };
  for (let i = 0; i < 2; i++) {
    const result = await createGitHubReviewIssue(fetchImpl, 'https://api.github.com', 'token', githubTarget, createInput());
    assert.equal(result.number, 12);
    assert.equal(result.duplicate, true);
  }
  assert.equal(calls.length, 2);
});

test('bounded discovery distinguishes complete absence from a cap or invalid page', async () => {
  const absent = await discoverActiveGitHubReviewIssue(async () => Response.json([]),
    'https://api.github.com', 'token', githubTarget);
  assert.equal(absent, null);
  let pages = 0;
  await assert.rejects(createGitHubReviewIssue(async (_input, init) => {
    assert.notEqual(init?.method, 'POST');
    pages++;
    return Response.json(Array.from({ length: 100 }, (_, i) => issue(i + 1, 'unrelated')));
  }, 'https://api.github.com', 'token', githubTarget, createInput()), /incomplete after 500/);
  assert.equal(pages, 5);
  await assert.rejects(discoverActiveGitHubReviewIssue(async () => Response.json({}),
    'https://api.github.com', 'token', githubTarget), /invalid page/);
});

test('unknown reconciliation includes closed issues and refuses unsafe legacy keys', async () => {
  const result = await reconcileUnknownGitHubReviewIssue(async input => {
    assert.equal(new URL(String(input)).searchParams.get('state'), 'all');
    assert.equal(new URL(String(input)).searchParams.has('creator'), false);
    return Response.json([{ ...issue(), state: 'closed' }]);
  }, 'https://api.github.com', 'token', githubTarget, 'different-account', expectedDuplicateKey());
  assert.equal(result?.state, 'closed');
  const legacy = `github-issue:${createHash('sha256').update(`github-issue\ncontoso/docs\n${githubTarget.path}`).digest('hex')}`;
  await assert.rejects(reconcileUnknownGitHubReviewIssue(async () => { throw new Error('Must not fetch'); },
    'https://api.github.com', 'token', githubTarget, 'other', legacy), /Legacy unknown/);
  await assert.rejects(discoverActiveGitHubReviewIssue(async () => Response.json([
    issue(12, `Source document: https://github.com/Contoso/Docs/blob/main/PRDs/Request.md\n<!-- docthread-review-key:${legacy} -->`),
  ]), 'https://api.github.com', 'token', githubTarget), /Legacy DocThread issue.*manual resolution/);
});

test('different refs do not collide in provider discovery', async () => {
  assert.equal(await discoverActiveGitHubReviewIssue(async () => Response.json([issue()]),
    'https://api.github.com', 'token', { ...githubTarget, ref: 'other' }), null);
});

test('hidden and old canceled records preserve provider truth and block duplicates', () => {
  const record = makeGitHubReviewRecord({
    id: 'one', sourceKey: 'source-key', sourceBranch: 'main', preview: preview(),
    externalUrl: issue().html_url, externalNumber: 12, nowIso: '2026-09-15T00:00:00Z',
  });
  const hidden = { ...record, hidden: true };
  assert.equal(findActiveGitHubIssueDuplicate([hidden], githubTarget)?.id, 'one');
  const [migrated] = parseReviewRequestRecords(JSON.stringify([{ ...record, status: 'canceled' }]));
  assert.equal(migrated.hidden, true);
  assert.equal(migrated.providerState, 'open');
  assert.equal(migrated.status, 'stale');
  assert.equal(findActiveGitHubIssueDuplicate([migrated], githubTarget)?.id, 'one');
  const [unknown] = parseReviewRequestRecords(JSON.stringify([{ ...record, status: 'canceled', providerState: 'unknown' }]));
  assert.equal(unknown.status, 'unknown');
  assert.equal(findActiveGitHubIssueDuplicate([{ ...hidden, providerState: 'closed' }], githubTarget), undefined);
});

test('source-filtered custody merges latest storage and memory without discarding independent updates', () => {
  const base = makeUnknownGitHubIssueRecord({
    id: 'one', sourceKey: 'source-key', sourceBranch: 'main', preview: preview(), nowIso: '2026-09-15T00:00:00Z',
  });
  const newer = { ...base, hidden: true, updatedAt: '2026-09-15T01:00:00Z' };
  const other = { ...base, id: 'two' };
  const foreign = { ...base, id: 'foreign', sourceKey: 'other-source' };
  assert.deepEqual(mergeReviewRequestRecords('source-key', [newer, other, foreign], [base]), [newer, other]);
  assert.deepEqual(loadReviewRequestRecords({ getItem: () => JSON.stringify([base, foreign]), setItem() {} }, 'source-key'), [base]);
});

test('signed-out and stale-scope mutations are refused before POST, including after discovery', async () => {
  await assert.rejects(createGitHubReviewIssue(async () => { throw new Error('Must not fetch'); },
    'https://api.github.com', '', githubTarget, createInput()), /Sign in/);
  let current = true;
  let reads = 0;
  await assert.rejects(createGitHubReviewIssue(async (_input, init) => {
    assert.notEqual(init?.method, 'POST');
    reads++;
    current = false;
    return Response.json([]);
  }, 'https://api.github.com', 'token', githubTarget, { ...createInput(), isCurrent: () => current }), /Source or account changed/);
  assert.equal(reads, 1);
  await assert.rejects(assignGitHubReviewIssueReviewers(async () => { throw new Error('Must not fetch'); },
    'https://api.github.com', '', githubTarget, 12, ['Octocat'], () => false), /Source or account changed/);
});

test('existing PR helper remains separate for document-edit PR behavior', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method || 'GET'} ${url}`);
    if (url.includes('/pulls?')) return Response.json([]);
    if (url.includes('/compare/')) return Response.json({ ahead_by: 2, status: 'ahead' });
    if (url.endsWith('/pulls') && init?.method === 'POST') {
      return Response.json({ id: 42, number: 7, html_url: 'https://github.com/contoso/docs/pull/7', state: 'open' });
    }
    return Response.json({ name: 'branch' });
  };
  const result = await createGitHubReviewPullRequest(fetchImpl, 'https://api.github.com', 'token', githubTarget, {
    title: 'Edit PR',
    body: 'Body',
    targetBranch: 'main',
    reviewers: [],
  });
  assert.equal(result.url, 'https://github.com/contoso/docs/pull/7');
  assert.equal(requests.some((request) => request.includes('/pulls')), true);
  assert.equal(requests.some((request) => request.includes('/issues')), false);
});
