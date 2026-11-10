export default async function reviewSessionInsightsScenarios(page, options) {
  const { app } = options;
  const fixtureResponse = await page.request.get(`${app}/tests/reviewUi.fixture.js`);
  if (!fixtureResponse.ok()) throw new Error('The existing browser fixture could not be loaded.');
  const fixture = await fixtureResponse.text();
  const results = [];
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const source = (name, ref = 'main') => `https://github.com/example/${name}/blob/${ref}/docs/review.md`;
  const route = (name, mode = 'insights', ref = 'main') => `${app}/?ui-check=${mode}&doc=${encodeURIComponent(source(name, ref))}`;

  async function scenario(name, execute) {
    const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(15000);
    await options.prepareContext(context);
    await context.addInitScript({ content: fixture });
    const check = await context.newPage();
    const pageErrors = [];
    check.on('pageerror', error => pageErrors.push(error.message));
    check.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    try {
      await execute(check);
      await options.checkPage(check, name);
      expect(pageErrors.length === 0, `${name}: ${pageErrors.join('; ')}`);
      expect((await check.evaluate(() => window.docThreadTest.unexpected)).length === 0, `${name}: unexpected provider request`);
      results.push({ scenario: name, passed: true });
    } finally {
      await context.close();
    }
  }

  async function openInsights(check) {
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Session review insights', exact: true }).click();
    const dialog = check.getByRole('dialog', { name: 'Session review insights', exact: true });
    await dialog.waitFor();
    return dialog;
  }

  async function enable(check) {
    const dialog = await openInsights(check);
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).check();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }

  async function run(check, wait = true) {
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'AI Review', exact: true }).click();
    if (wait) await finished(check);
  }

  async function finished(check) {
    await check.waitForFunction(() => !Array.from(document.querySelectorAll('.tools-menu button')).some(button => button.textContent === 'Reviewing...'));
    await check.locator('.review-finding').first().waitFor();
  }

  async function counts(dialog) {
    return dialog.locator('[data-session-count]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.sessionCount, Number(element.textContent)])));
  }

  async function download(check, dialog) {
    const pending = check.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const receipt = await pending;
    expect(receipt.suggestedFilename() === 'docthread-session-review-insights.json', 'Export filename contains variable data');
    const stream = await receipt.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(await receipt.failure() === null, 'JSON download did not complete');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  const finding = (check, title) => check.locator('.review-finding').filter({ has: check.getByText(title, { exact: true }) });

  await scenario('insights opt-in, final cohorts, reruns and first outcomes', async check => {
    await check.goto(route('insights-outcomes'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    expect(await check.getByRole('dialog', { name: 'Session review insights', exact: true }).count() === 0, 'Insights appeared by default');
    const callsAtStart = await check.evaluate(() => window.docThreadTest.calls.length);
    await run(check);
    const uncapturedCalls = await check.evaluate(start => window.docThreadTest.calls.slice(start), callsAtStart);
    await options.checkPage(check, 'insights displayed findings keyboard surface');
    const firstSize = await check.locator('.review-finding').count();
    let dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Default-off run was captured');
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).check();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await finding(check, 'Fixture dismiss').getByRole('button', { name: 'Dismiss', exact: true }).click();
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Opt-in retroactively captured an existing finding');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const callsBeforeCapture = await check.evaluate(() => window.docThreadTest.calls.length);
    await run(check);
    expect(JSON.stringify(await check.evaluate(start => window.docThreadTest.calls.slice(start), callsBeforeCapture)) === JSON.stringify(uncapturedCalls), 'Capture changed the existing review request sequence');
    const size = await check.locator('.review-finding').count();
    expect(size === firstSize, 'Equivalent rerun changed its displayed cohort');
    await finding(check, 'Fixture post').getByRole('button', { name: 'Post as thread', exact: true }).focus();
    await check.keyboard.press('Enter');
    expect(await finding(check, 'Fixture post').count() === 0, 'Keyboard Accept was intercepted by its finding container');
    await finding(check, 'Fixture apply').getByRole('button', { name: 'Post thread and apply to draft', exact: true }).click();
    const save = check.getByRole('dialog', { name: 'Save your edits to GitHub', exact: true });
    await save.getByRole('button', { name: 'Keep in this tab', exact: true }).click();
    await finding(check, 'Fixture stale').getByRole('button', { name: 'Post thread and apply to draft', exact: true }).click();
    await finding(check, 'Fixture dismiss').getByRole('button', { name: 'Dismiss', exact: true }).focus();
    await check.keyboard.press('Space');
    dialog = await openInsights(check);
    const summary = await download(check, dialog);
    expect(summary.counts.observed === size && summary.counts.posted === 2 && summary.counts.applied === 1 && summary.counts.dismissed === 1, 'Actual outcomes or combined/stale apply counts are wrong');
    expect(summary.counts.pending === size - 4 && summary.counts.rate === 0.75, 'Pending contaminated decision uptake');
    expect(summary.by_origin.ai.denominator === 4 && summary.by_origin.local.pending > 0, 'Local and AI origins were mixed');
    expect(summary.by_pass.other.dismissed === 1, 'Custom pass was not normalized');
    expect((await check.evaluate(() => window.docThreadTest.calls.filter(call => call.method === 'PUT').length)) === 0, 'Combined accept wrote source without confirmation');
    await dialog.evaluate(element => { element.scrollTop = 0; });
    expect(await dialog.evaluate(element => element.getBoundingClientRect().width >= 650), 'Inherited modal width squeezed the insights layout');
    await options.checkPage(check, 'insights actual outcomes desktop');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await run(check);
    const nextSize = await check.locator('.review-finding').count();
    dialog = await openInsights(check);
    const rerun = await download(check, dialog);
    expect(rerun.coverage.captured_runs === 2 && rerun.counts.observed === size + nextSize, 'Rerun reused finding IDs or lost frozen pending observations');
  });

  await scenario('insights exclude policy-hidden, capped and unanchorable findings', async check => {
    await check.goto(`${app}/?ui-check=insights`, { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Comments', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      fixture.markdown += '\n' + 'Ordinary context remains separate. '.repeat(20) + '\nExcluded policy passage.\n';
      fixture.policyText = '## Cap\n1\n\n## Exclude\n- Excluded policy passage\n';
      const template = fixture.reviewFindings[0];
      fixture.reviewFindings = [template,
        ...Array.from({ length: 3 }, (_, index) => ({ ...template, severity: 'nit', title: `Capped nit ${index}` })),
        { ...template, quote: 'Excluded policy passage.', title: 'Policy-hidden finding' },
        { ...template, quote: 'This quote does not exist.', title: 'Unanchorable finding' }];
    });
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Open document', exact: true }).click();
    await check.getByLabel('Document URL', { exact: true }).fill(source('insights-policy'));
    await check.getByRole('dialog', { name: 'Open document', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await run(check);
    const displayed = await check.locator('.review-finding').count();
    expect(await finding(check, 'Policy-hidden finding').count() === 0 && await finding(check, 'Unanchorable finding').count() === 0, 'Hidden finding is unexpectedly displayed');
    expect(await finding(check, 'Capped nit 1').count() === 0 && await finding(check, 'Capped nit 2').count() === 0, 'Nit cap was bypassed');
    const dialog = await openInsights(check);
    const exported = await download(check, dialog);
    expect(exported.counts.observed === displayed && exported.by_origin.ai.observed === 2, 'Capture included policy-hidden or capped findings');
  });

  await scenario('insights failed posting stays pending and retry records once', async check => {
    await check.goto(route('insights-post-failure'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await run(check);
    const size = await check.locator('.review-finding').count();
    const before = await check.evaluate(() => window.docThreadTest.calls.length);
    await check.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new Error('Synthetic storage denial'); };
      window.docThreadTest.restoreStorage = () => { Storage.prototype.setItem = original; };
    });
    await finding(check, 'Fixture post').getByRole('button', { name: 'Post as thread', exact: true }).click();
    expect(await finding(check, 'Fixture post').count() === 1, 'Failed post removed its finding');
    let dialog = await openInsights(check);
    expect((await counts(dialog)).pending === size, 'Failed post produced a verdict');
    expect((await check.evaluate(() => window.docThreadTest.calls.length)) === before, 'Failed local post started provider activity');
    await check.evaluate(() => window.docThreadTest.restoreStorage());
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await finding(check, 'Fixture post').getByRole('button', { name: 'Post as thread', exact: true }).evaluate(button => { button.click(); button.click(); });
    dialog = await openInsights(check);
    expect((await counts(dialog)).posted === 1, 'Repeated callback counted more than one successful post');
    expect(await check.locator('.thread').filter({ hasText: 'Fixture post' }).count() === 1, 'Repeated callback duplicated a thread');
  });

  await scenario('insights clear, off, no retroactivity and delayed completion', async check => {
    await check.goto(route('insights-clearing'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await run(check);
    let dialog = await openInsights(check);
    await dialog.getByRole('button', { name: 'Clear captured data', exact: true }).click();
    expect((await counts(dialog)).observed === 0, 'Clear retained observations');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await finding(check, 'Fixture dismiss').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdReview = true; });
    await run(check, false);
    await check.waitForFunction(() => window.docThreadTest.reviewReleases.length === 1);
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Cleared cohort was observed retroactively');
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).check();
    await check.evaluate(() => window.docThreadTest.reviewReleases[0]());
    await check.waitForFunction(() => document.querySelectorAll('.review-finding').length > 0);
    expect((await counts(dialog)).observed === 0, 'Delayed completion crossed off/on generation');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdReview = false; });
    await run(check);
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed > 0, 'Fresh run after clear did not capture');
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).uncheck();
    expect((await counts(dialog)).observed === 0, 'Turning capture off retained data');
    expect(await dialog.getByRole('button', { name: 'Export JSON', exact: true }).isDisabled(), 'Off state exposes a recoverable export');
  });

  await scenario('insights source switch, teardown, reload and stale source completion', async check => {
    await check.goto(route('insights-source-first'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await run(check);
    await check.evaluate(() => { window.docThreadTest.holdReview = true; });
    await run(check, false);
    await check.waitForFunction(() => window.docThreadTest.reviewReleases.length === 1);
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Open document', exact: true }).click();
    await check.getByLabel('Document URL', { exact: true }).fill(source('insights-source-second'));
    await check.getByRole('dialog', { name: 'Open document', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
    await check.waitForFunction(() => document.querySelector('.source-context').textContent.includes('insights-source-second'));
    await check.evaluate(() => window.docThreadTest.reviewReleases[0]());
    let dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Source switch retained observations');
    expect(!(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).isChecked()), 'Source switch kept capture enabled');
    expect(await check.locator('.review-finding').count() === 0, 'Old source completion populated the new source');
    await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).check();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.holdReview = false; });
    await run(check);
    await check.reload({ waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Reload recovered session observations');
    expect(!(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).isChecked()), 'Reload recovered capture opt-in');
  });

  await scenario('insights draft boundary and superseded runs reject late results', async check => {
    await check.goto(route('insights-draft-boundary'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await check.evaluate(() => { window.docThreadTest.holdReview = true; });
    await run(check, false);
    await check.waitForFunction(() => window.docThreadTest.reviewReleases.length === 1);
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Edit document', exact: true }).click();
    const draft = (await check.locator('.editor-input').inputValue()) + '\nA newer manual draft remains here.\n';
    await check.locator('.editor-input').fill(draft);
    await check.getByRole('button', { name: 'Apply draft', exact: true }).click();
    await check.getByRole('dialog', { name: 'Save your edits to GitHub', exact: true }).getByRole('button', { name: 'Keep in this tab', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.reviewFindings = [{ ...window.docThreadTest.reviewFindings[0], title: 'New draft finding' }]; });
    await run(check, false);
    await check.waitForFunction(() => window.docThreadTest.reviewReleases.length === 2);
    await check.evaluate(() => window.docThreadTest.reviewReleases[1]());
    await finished(check);
    expect(await finding(check, 'New draft finding').count() === 1, 'New draft run did not finish');
    const size = await check.locator('.review-finding').count();
    await check.evaluate(() => window.docThreadTest.reviewReleases[0]());
    const dialog = await openInsights(check);
    const exported = await download(check, dialog);
    expect(exported.counts.observed === size && exported.coverage.captured_runs === 1, 'Superseded draft run entered the cohort');
    expect(await finding(check, 'Fixture post').count() === 0 && await finding(check, 'New draft finding').count() === 1, 'Stale completion replaced the newer displayed findings');
    expect((await check.locator('.doc').innerText()).includes('A newer manual draft remains here.'), 'Review completion overwrote the manual draft');
    expect(await check.evaluate(() => window.docThreadTest.calls.filter(call => call.method === 'PUT').length) === 0, 'Review wrote the document source');
  });

  await scenario('insights sign-out and replacement account clear capture', async check => {
    await check.goto(route('insights-auth'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await enable(check);
    await run(check);
    await check.evaluate(() => { window.docThreadTest.holdReview = true; });
    await run(check, false);
    await check.waitForFunction(() => window.docThreadTest.reviewReleases.length === 1);
    await check.getByRole('button', { name: 'Sign out', exact: true }).click();
    let dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Sign-out retained capture');
    expect(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).isDisabled(), 'Signed-out capture remains available');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.identity = { login: 'replacement_reviewer', name: 'Replacement reviewer', nodeId: 'U_replacement' }; });
    await check.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await check.locator('.auth-status').filter({ hasText: 'replacement_reviewer' }).waitFor();
    await check.evaluate(() => window.docThreadTest.reviewReleases[0]());
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed === 0, 'Old account completion entered replacement account capture');
    expect(!(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).isChecked()), 'Account change reused opt-in');
  });

  for (const mode of ['signed-out', 'read-only', 'sample', 'unavailable']) {
    await scenario(`insights disabled for ${mode}`, async check => {
      const url = mode === 'sample' ? `${app}/?ui-check=insights`
        : mode === 'unavailable' ? `${app}/?ui-check=insights&doc=${encodeURIComponent('https://dev.azure.com/example/Docs/_workitems/edit/42')}`
        : route('insights-disabled', mode === 'signed-out' ? 'signed-out' : 'insights', mode === 'read-only' ? 'v1' : 'main');
      await check.goto(url, { waitUntil: 'domcontentloaded' });
      await check.getByRole('heading', { name: 'Comments', exact: true }).waitFor();
      if (mode === 'read-only') await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
      const dialog = await openInsights(check);
      expect(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).isDisabled(), `${mode} can opt in`);
      expect((await counts(dialog)).observed === 0, `${mode} has observations`);
    });
  }

  await scenario('insights privacy, inspection, export failure, retry and keyboard layout', async check => {
    await check.goto(route('insights-privacy'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    const sentinel = 'SENTINEL_PRIVATE prose reviewer@example.test https://private.test/path/document.md SECRET-SKILL';
    await check.evaluate(value => {
      window.docThreadTest.reviewFindings = [{ quote: 'The release plan needs a documented rollback.', title: value, rationale: value, replacement: value, skillName: value, pass: value, severity: 'important' }];
    }, sentinel);
    const logged = [];
    check.on('console', message => logged.push(message.text()));
    const storageBefore = await check.evaluate(() => JSON.stringify([Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()]));
    const reviewBefore = await check.evaluate(() => JSON.stringify(window.docThreadTest.remote));
    await enable(check);
    await run(check);
    await finding(check, sentinel).getByRole('button', { name: 'Dismiss', exact: true }).click();
    let dialog = await openInsights(check);
    const before = await counts(dialog);
    const callsBefore = await check.evaluate(() => window.docThreadTest.calls.length);
    await check.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = () => { throw new Error('Synthetic download failure'); };
      window.docThreadTest.restoreDownload = () => { URL.createObjectURL = original; };
    });
    await dialog.getByRole('button', { name: 'Export JSON', exact: true }).click();
    await dialog.getByText('Download failed. Captured data is still in memory. Retry export before leaving.', { exact: true }).waitFor();
    expect(JSON.stringify(await counts(dialog)) === JSON.stringify(before), 'Download failure lost memory');
    await check.evaluate(() => window.docThreadTest.restoreDownload());
    const exported = await download(check, dialog);
    expect(!JSON.stringify(exported).includes(sentinel), 'Export leaked private finding text');
    expect(!/SENTINEL_PRIVATE|reviewer@example|private\.test|SECRET-SKILL|run-\d|observation-\d/.test(JSON.stringify(exported)), 'Export leaked raw metadata or IDs');
    expect(exported.by_pass.other.dismissed === 1, 'Private custom pass was not normalized');
    expect(exported.counts.dismissed === 1, 'Dismiss did not capture');
    expect(await check.evaluate(() => JSON.stringify(window.docThreadTest.remote)) === reviewBefore, 'Inspect/export changed review data');
    expect(await check.evaluate(() => JSON.stringify([Object.entries(localStorage).sort(), Object.entries(sessionStorage).sort()])) === storageBefore, 'Capture/inspect/export wrote persistent storage');
    expect(await check.evaluate(() => window.docThreadTest.calls.length) === callsBefore, 'Inspect/export triggered a network call');
    expect(logged.every(message => !message.includes('SENTINEL_PRIVATE')), 'Captured prose reached logs');
    await options.checkPage(check, 'insights privacy and export retry desktop');
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
    await check.keyboard.press('Tab');
    expect(await dialog.getByRole('checkbox', { name: 'Capture session decisions', exact: true }).evaluate(element => element === document.activeElement), 'Dialog Tab did not wrap focus');
    await check.keyboard.press('Shift+Tab');
    expect(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(element => element === document.activeElement), 'Dialog Shift+Tab did not wrap focus');
    await check.keyboard.press('Escape');
    expect(await check.locator('.tools-menu > summary').evaluate(element => element === document.activeElement), 'Escape did not return focus to Tools');
    dialog = await openInsights(check);
    for (const width of [390, 320]) {
      await check.setViewportSize({ width, height: 900 });
      const fits = await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
      expect(fits, `Insights overflow at ${width}px`);
      await dialog.evaluate(element => { element.scrollTop = 0; });
      const headingsFit = await dialog.locator('thead th').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height < 36));
      expect(headingsFit, `Insights table headings broke across lines at ${width}px`);
      await options.checkPage(check, `insights narrow ${width}`);
    }
  });

  await scenario('insights capacity refuses whole run, preserves prior data and resets', async check => {
    await check.goto(route('insights-capacity'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const template = window.docThreadTest.reviewFindings[0];
      window.docThreadTest.reviewFindings = Array.from({ length: 100 }, (_, index) => ({ ...template, title: `Capacity finding ${index}` }));
    });
    await enable(check);
    await run(check);
    const size = await check.locator('.review-finding').count();
    const fittingRuns = Math.floor(1000 / size);
    for (let index = 1; index <= fittingRuns; index += 1) await run(check);
    let dialog = await openInsights(check);
    await dialog.getByText(/Capture paused at the 1,000-observation limit/).waitFor();
    const paused = await download(check, dialog);
    expect(paused.counts.observed === fittingRuns * size, 'Capacity silently truncated or evicted observations');
    expect(paused.coverage.omitted_runs_capacity === 1 && paused.coverage.omitted_observations_capacity === size, 'Capacity did not omit the whole run');
    expect(await check.locator('.review-finding').count() === size, 'Capacity interrupted normal review');
    await options.checkPage(check, 'insights capacity paused');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await finding(check, 'Capacity finding 0').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await run(check);
    dialog = await openInsights(check);
    const stillPaused = await download(check, dialog);
    expect(stillPaused.counts.dismissed === 0 && stillPaused.coverage.runs_started_while_paused === 1, 'Omitted/paused runs acquired observations');
    await dialog.getByRole('button', { name: 'Clear captured data', exact: true }).click();
    expect((await counts(dialog)).observed === 0, 'Capacity reset retained observations');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await run(check);
    dialog = await openInsights(check);
    expect((await counts(dialog)).observed === size, 'Clear did not resume capture');
  });
  return results;
}