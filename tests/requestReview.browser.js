import { createHash } from 'node:crypto';

const requestReviewStorageKey = key => `docthread:request-review:${key}`;
const requestReviewDraftStorageKey = key => `docthread:request-review-draft:${key}`;
const draft = title => ({ channel: 'github-issue', title, instructions: 'Please review.', scope: 'Document',
  reviewersText: '', targetBranch: '', createdAt: '2026-09-16T00:00:00Z' });

function installIssueFixture(config) {
  const previousFetch = window.fetch;
  const fixture = window.docThreadTest;
  const issues = structuredClone(config.issues ?? {});
  fixture.issueCalls = [];
  fixture.issueHolds = [];
  fixture.holdIssueReads = false;
  fixture.holdIssueCreate = false;
  fixture.holdIssueDiscovery = false;
  fixture.unknownIssueCreate = false;
  fixture.emptyIssueDiscovery = false;
  window.open = () => null;
  for (const [key, value] of Object.entries(config.storage ?? {})) localStorage.setItem(key, JSON.stringify(value));
  fixture.draftWrites = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (key.startsWith('docthread:request-review-draft:')) fixture.draftWrites.push({ key, title: JSON.parse(value).title });
    return setItem.call(this, key, value);
  };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = options.method || 'GET';
    const match = /^\/gh-api\/repos\/example\/([^/]+)\/issues(?:\/(\d+)(\/assignees)?)?$/.exec(url.pathname);
    if (!match) return previousFetch(input, options);
    const [, repo, number, assignees] = match;
    fixture.issueCalls.push({ method, repo, number, search: url.search, body: options.body ? JSON.parse(options.body) : undefined });
    const records = issues[repo] ??= [];
    let result;
    let hold = false;
    if (method === 'GET' && !number) {
      result = fixture.emptyIssueDiscovery ? [] : records.filter(issue => url.searchParams.get('state') === 'all' || issue.state === 'open');
      hold = fixture.holdIssueDiscovery;
    } else if (method === 'GET' && number) {
      result = records.find(issue => issue.number === Number(number));
      hold = fixture.holdIssueReads;
    } else if (method === 'POST' && !number) {
      const body = JSON.parse(options.body);
      result = { id: 1042, number: 42, html_url: `https://github.com/example/${repo}/issues/42`, state: 'open',
        assignees: (body.assignees ?? []).map(login => ({ login })), body: body.body };
      records.push(result);
      if (fixture.unknownIssueCreate) throw new Error('Simulated unknown create outcome');
      hold = fixture.holdIssueCreate;
    } else if (method === 'POST' && assignees) {
      result = records.find(issue => issue.number === Number(number));
      const names = new Set([...result.assignees.map(user => user.login), ...JSON.parse(options.body).assignees]);
      result.assignees = [...names].map(login => ({ login }));
    } else {
      fixture.unexpected.push({ method, path: url.pathname });
      throw new Error('Unexpected issue fixture request');
    }
    if (!result) throw new Error(`Missing fixture issue ${repo}/${number}`);
    const snapshot = structuredClone(result);
    if (hold) return new Promise(resolve => fixture.issueHolds.push(() => resolve(json(snapshot))));
    return json(snapshot);
  };
}

export default async function requestReviewScenarios(page, options) {
  const { app } = options;
  const response = await page.request.get(`${app}/tests/reviewUi.fixture.js`);
  if (!response.ok()) throw new Error('Review fixture unavailable');
  const fixture = await response.text();
  const results = [];
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const key = repo => `docthread:v2:${Buffer.from(JSON.stringify({
    provider: 'github', owner: 'example', repo, versionType: 'branch', ref: 'main', path: 'docs/review.md',
  })).toString('base64url')}`;
  const url = repo => `https://github.com/example/${repo}/blob/main/docs/review.md`;
  const seed = (repo, number) => {
    const duplicateKey = `github-issue:v2:${createHash('sha256').update(JSON.stringify(['github-issue-v2', 'example', repo, 'docs/review.md', 'branch', 'main'])).digest('hex')}`;
    const provider = { id: number + 100, number, html_url: `https://github.com/example/${repo}/issues/${number}`, state: 'closed',
      body: `<!-- docthread-review-key:${duplicateKey} -->`, assignees: [{ login: 'existing' }] };
    const timestamp = new Date().toISOString();
    const record = { id: `rr-${number}`, sourceKey: key(repo), sourceBranch: 'main', channel: 'github-issue',
      title: 'Review fixture', scope: 'Document', instructions: 'Please review.', requestedReviewers: ['existing'],
      duplicateKey, status: 'requested', externalNumber: number, externalUrl: provider.html_url, providerState: 'open',
      createdAt: timestamp, updatedAt: timestamp, lastRefreshAt: timestamp };
    return { provider, record };
  };
  async function scenario(name, config, run) {
    const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15000);
    await options.prepareContext(context);
    await context.addInitScript({ content: `${fixture}\n(${installIssueFixture.toString()})(${JSON.stringify(config)});` });
    const check = await context.newPage();
    const errors = [];
    check.on('pageerror', error => errors.push(error.message));
    check.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    try {
      await check.goto(`${app}/?ui-check=insights&doc=${encodeURIComponent(url(config.repo))}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
      await run(check);
      await options.checkPage(check, name);
      expect(errors.length === 0, errors.join('; '));
      expect((await check.evaluate(() => window.docThreadTest.unexpected)).length === 0, 'Unexpected provider requests');
      results.push({ scenario: name, passed: true });
    } finally { await context.close(); }
  }
  async function open(check) {
    await check.getByRole('button', { name: 'Request review', exact: true }).click();
    const dialog = check.getByRole('dialog', { name: 'Request review', exact: true });
    await dialog.waitFor();
    return dialog;
  }
  async function switchSource(check, repo) {
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Open document', exact: true }).click();
    await check.getByLabel('Document URL', { exact: true }).fill(url(repo));
    await check.getByRole('dialog', { name: 'Open document', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    await check.waitForFunction(repo => document.querySelector('.source-context').textContent.includes(repo), repo);
  }
  const writes = check => check.evaluate(() => window.docThreadTest.issueCalls.filter(call => call.method === 'POST' && !call.number).length);
  const stored = (check, repo) => check.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), requestReviewStorageKey(key(repo)));

  const a = seed('request-a', 12);
  const bDraft = { ...draft('B draft'), instructions: 'Keep B instructions' };
  await scenario('request source isolation and draft preservation', {
    repo: 'request-a', issues: { 'request-a': [a.provider] },
    storage: { [requestReviewStorageKey(key('request-a'))]: [a.record], [requestReviewDraftStorageKey(key('request-b'))]: bDraft },
  }, async check => {
    let dialog = await open(check);
    await dialog.getByLabel('Title', { exact: true }).fill('Keep A draft');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdIssueReads = true; });
    await check.getByRole('region', { name: 'Review requests', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
    await check.waitForFunction(() => window.docThreadTest.issueHolds.length === 1);
    await switchSource(check, 'request-b');
    await check.evaluate(() => window.docThreadTest.issueHolds[0]());
    dialog = await open(check);
    expect(await dialog.getByLabel('Title', { exact: true }).inputValue() === 'B draft', 'A draft overwrote B');
    expect(await dialog.getByLabel('Instructions', { exact: true }).inputValue() === 'Keep B instructions', 'B draft was replaced');
    expect(!(await check.evaluate(key => window.docThreadTest.draftWrites.some(write => write.key === key && write.title !== 'B draft'),
      requestReviewDraftStorageKey(key('request-b')))), 'A draft was transiently written under B even though hydration later repaired it');
    expect((await stored(check, 'request-b')).length === 0, 'A refresh entered B storage');
    expect(await check.locator('.request-review-summary li').count() === 0, 'A refresh entered B UI');
    expect(!(await check.evaluate(() => window.docThreadTest.issueCalls.some(call => call.repo === 'request-b'))), 'A record refreshed against B repository');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await switchSource(check, 'request-a');
    dialog = await open(check);
    expect(await dialog.getByLabel('Title', { exact: true }).inputValue() === 'Keep A draft', 'A draft lost on source return');
    expect((await stored(check, 'request-a'))[0].providerState === 'open', 'Stale A refresh committed after switch');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.markdown = '# Retitled fixture\n\nThe release plan needs a documented rollback.\n'; });
    await switchSource(check, 'request-a');
    await check.getByRole('heading', { name: 'Retitled fixture', exact: true }).waitFor();
    dialog = await open(check);
    expect(await dialog.getByLabel('Title', { exact: true }).inputValue() === 'Keep A draft', 'Source title update reset draft');
  });

  const one = seed('request-parallel', 12);
  const two = seed('request-parallel', 13);
  const extra = seed('request-parallel', 14);
  await scenario('request parallel refresh preserves hide and independent storage updates', {
    repo: 'request-parallel', issues: { 'request-parallel': [one.provider, two.provider] },
    storage: { [requestReviewStorageKey(key('request-parallel'))]: [one.record, two.record] },
  }, async check => {
    await check.evaluate(() => { window.docThreadTest.holdIssueReads = true; });
    const region = check.getByRole('region', { name: 'Review requests', exact: true });
    const first = region.getByRole('listitem').filter({ hasText: /GitHub Issue #12\b/ });
    const second = region.getByRole('listitem').filter({ hasText: /GitHub Issue #13\b/ });
    await first.getByRole('button', { name: 'Refresh', exact: true }).click();
    await second.getByRole('button', { name: 'Refresh', exact: true }).click();
    await check.waitForFunction(() => window.docThreadTest.issueHolds.length === 2);
    await first.getByRole('button', { name: 'Hide from this browser', exact: true }).click();
    await check.evaluate(({ key, record }) => {
      const records = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify([...records, record]));
    }, { key: requestReviewStorageKey(key('request-parallel')), record: extra.record });
    await check.evaluate(() => { window.docThreadTest.issueHolds[1](); window.docThreadTest.issueHolds[0](); });
    await check.waitForFunction(key => JSON.parse(localStorage.getItem(key)).some(record => record.providerState === 'closed'), requestReviewStorageKey(key('request-parallel')));
    const records = await stored(check, 'request-parallel');
    expect(records.filter(record => record.providerState === 'closed').length === 2, 'Parallel refresh lost a provider update');
    expect(records.length === 3, 'Parallel refresh discarded another record');
    expect(records.find(record => record.id === one.record.id).hidden, 'Refresh undid hide');
    expect(records.find(record => record.id === one.record.id).confirmedAssignees?.join(',') === 'existing', 'Refresh lost authoritative assignees');
    await region.getByRole('checkbox', { name: 'Show hidden requests', exact: true }).check();
    expect(await region.getByRole('button', { name: 'Show in this browser', exact: true }).count() === 1, 'Hidden request is not recoverable');
  });

  await scenario('request repeated submit storage failure retains receipt and hidden duplicate', { repo: 'request-create' }, async check => {
    let dialog = await open(check);
    await dialog.getByLabel('GitHub reviewers', { exact: true }).fill('existing');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await check.evaluate(() => {
      window.docThreadTest.holdIssueCreate = true;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('docthread:request-review:')) throw new Error('Fixture storage unavailable');
        return original.call(this, key, value);
      };
      window.docThreadTest.restoreStorage = () => { Storage.prototype.setItem = original; };
    });
    await dialog.getByRole('button', { name: /^Create review request/ }).evaluate(button => {
      // Exercise the retained callback twice, not just the DOM's disabled-button protection.
      const callback = button[Object.keys(button).find(key => key.startsWith('__reactProps'))].onClick;
      callback();
      callback();
    });
    await check.waitForFunction(() => window.docThreadTest.issueHolds.length >= 1);
    expect(await writes(check) === 1, 'Repeated callback created twice before the first receipt');
    await check.evaluate(() => window.docThreadTest.issueHolds[0]());
    await dialog.waitFor({ state: 'hidden' });
    expect(await writes(check) === 1, 'Repeated callback created twice');
    await check.getByText(/retained in this tab but could not be saved/).waitFor();
    await check.evaluate(() => window.docThreadTest.restoreStorage());
    const region = check.getByRole('region', { name: 'Review requests', exact: true });
    await region.getByRole('button', { name: 'Hide from this browser', exact: true }).click();
    dialog = await open(check);
    await dialog.getByLabel('GitHub reviewers', { exact: true }).fill('new-person');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await dialog.getByRole('button', { name: /^Add assignees/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await writes(check) === 1, 'Hidden request permitted another create');
    const records = await stored(check, 'request-create');
    expect(records.length === 1 && records[0].hidden && records[0].providerState === 'open', 'Issue identity or hidden state changed');
    expect(records[0].confirmedAssignees.join(',') === 'existing,new-person', 'Add operation lost verified existing assignees');
  });

  await scenario('request stale create keeps original source receipt without touching new draft', { repo: 'request-pending' }, async check => {
    let dialog = await open(check);
    await dialog.getByLabel('GitHub reviewers', { exact: true }).fill('existing');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdIssueCreate = true; });
    await dialog.getByRole('button', { name: /^Create review request/ }).click();
    await check.waitForFunction(() => window.docThreadTest.issueHolds.length === 1);
    // Escape is deliberately blocked during mutation; source navigation is a separate App action.
    await check.evaluate(() => document.querySelector('.request-review-modal').closest('dialog')?.close());
    await check.evaluate(() => document.querySelector('.tools-menu').open = true);
    await check.getByRole('button', { name: 'Open document', exact: true }).evaluate(button => button.click());
    await check.getByLabel('Document URL', { exact: true }).fill(url('request-destination'));
    await check.getByRole('dialog', { name: 'Open document', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    await check.waitForFunction(() => document.querySelector('.source-context').textContent.includes('request-destination'));
    dialog = await open(check);
    await dialog.getByLabel('Title', { exact: true }).fill('Destination draft');
    await check.evaluate(() => window.docThreadTest.issueHolds[0]());
    await check.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '[]').length === 1, requestReviewStorageKey(key('request-pending')));
    expect(await dialog.isVisible(), 'Stale completion closed destination dialog');
    expect(await dialog.getByLabel('Title', { exact: true }).inputValue() === 'Destination draft', 'Stale completion changed destination draft');
    expect((await stored(check, 'request-destination')).length === 0, 'Creation receipt stored under destination');
  });

  await scenario('request auth invalidation retains draft and forbids stale mutation', { repo: 'request-auth' }, async check => {
    let dialog = await open(check);
    await dialog.getByLabel('Title', { exact: true }).fill('Keep account draft');
    await dialog.getByLabel('GitHub reviewers', { exact: true }).fill('existing');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdIssueDiscovery = true; });
    await dialog.getByRole('button', { name: /^Create review request/ }).click();
    await check.waitForFunction(() => window.docThreadTest.issueHolds.length === 1);
    await check.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true }).evaluate(button => button.click());
    expect(await dialog.getByRole('button', { name: 'Preview request', exact: true }).isDisabled(), 'Signed-out preview enabled');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).evaluate(button => {
      button[Object.keys(button).find(key => key.startsWith('__reactProps'))].onClick();
    });
    expect(await dialog.locator('.request-review-preview').count() === 0, 'Signed-out callback produced a preview');
    await check.evaluate(() => window.docThreadTest.issueHolds[0]());
    await check.waitForFunction(() => !document.querySelector('.request-review-modal .primary').textContent.includes('Checking'));
    expect(await writes(check) === 0, 'Stale preflight created after sign out');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.identity = { login: 'other', nodeId: 'U_other', name: 'Other' }; });
    await check.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await check.locator('.auth-status').filter({ hasText: 'other' }).waitFor();
    dialog = await open(check);
    expect(await dialog.getByLabel('Title', { exact: true }).inputValue() === 'Keep account draft', 'Account change reset draft');
    expect(await dialog.locator('.primary').isDisabled(), 'Old account preview remained callable');
  });

  await scenario('request unknown write survives account change and absence cannot permit retry', { repo: 'request-unknown' }, async check => {
    let dialog = await open(check);
    await dialog.getByLabel('GitHub reviewers', { exact: true }).fill('existing');
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.unknownIssueCreate = true; });
    await dialog.getByRole('button', { name: /^Create review request/ }).click();
    await dialog.getByRole('alert').filter({ hasText: 'outcome is unknown' }).waitFor();
    expect(await writes(check) === 1, 'Uncertain write repeated automatically');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await check.getByRole('button', { name: 'Sign out', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.identity = { login: 'other', nodeId: 'U_other', name: 'Other' }; });
    await check.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await check.locator('.auth-status').filter({ hasText: 'other' }).waitFor();
    dialog = await open(check);
    await dialog.getByRole('button', { name: 'Preview request', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.emptyIssueDiscovery = true; });
    await dialog.getByRole('button', { name: /^Create review request/ }).click();
    await dialog.getByRole('alert').filter({ hasText: 'previous write remains uncertain' }).waitFor();
    expect(await writes(check) === 1, 'Different account or no match bypassed uncertainty');
    expect((await stored(check, 'request-unknown'))[0].status === 'unknown', 'Unknown receipt was discarded');
    await check.evaluate(() => { window.docThreadTest.emptyIssueDiscovery = false; });
    await dialog.getByRole('button', { name: /^Create review request/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    const records = await stored(check, 'request-unknown');
    expect(records.length === 1 && records[0].externalNumber === 42 && records[0].providerState === 'open', 'Reconciliation lost or duplicated receipt');
    expect(await writes(check) === 1, 'Successful reconciliation created again');
    expect(await check.evaluate(() => window.docThreadTest.issueCalls.some(call => call.search.includes('state=all') && !call.search.includes('creator='))), 'Unknown read was not cross-account/all-state');
  });
  return results;
}
