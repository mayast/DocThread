export default async function reviewRecoveryScenarios(page, options = {}) {
  const app = options.app || 'http://localhost:5178';
  const ado = options.ado || 'http://localhost:5180';
  for (const address of [app, ado]) {
    const loopback = await page.evaluate(value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname), address);
    if (!loopback) throw new Error('Browser regressions require a loopback preview.');
  }
  const response = await page.request.get(`${app}/tests/reviewUi.fixture.js`);
  if (!response.ok()) throw new Error('The local fixture could not be loaded.');
  const fixture = await response.text();
  const results = [];
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const source = name => `https://github.com/example/${name}/blob/main/docs/review.md`;
  const htmlSource = name => `https://github.com/example/${name}/blob/main/docs/review.html`;
  const route = (name, mode = 'authorized') => `${app}/?ui-check=${mode}&doc=${encodeURIComponent(source(name))}`;

  async function scenario(name, execute, store) {
    const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(15000);
    if (options.prepareContext) await options.prepareContext(context);
    await context.addInitScript({ content: fixture });
    if (store) await context.addInitScript(value => localStorage.setItem('docthread:ado-review-store', value), store);
    const check = await context.newPage();
    const pageErrors = [];
    check.on('pageerror', error => pageErrors.push(error.message));
    check.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    try {
      await execute(check);
      if (options.checkPage) await options.checkPage(check, name);
      expect(pageErrors.length === 0, `${name}: ${pageErrors.join('; ')}`);
      expect((await check.evaluate(() => window.docThreadTest.unexpected)).length === 0, `${name}: an unexpected provider request occurred`);
      results.push({ scenario: name, passed: true });
    } finally {
      await context.close();
    }
  }

  async function openSource(check, url) {
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Open document', exact: true }).click();
    await check.getByLabel('Document URL', { exact: true }).fill(url);
    await check.getByRole('dialog', { name: 'Open document', exact: true }).getByRole('button', { name: 'Open', exact: true }).click();
  }

  async function openEditor(check) {
    await check.locator('.tools-menu > summary').click();
    await check.getByRole('button', { name: 'Edit document', exact: true }).click();
  }

  async function scan(check, name) {
    if (options.checkPage) await options.checkPage(check, name);
  }

  async function draftHighlight(check) {
    return check.evaluate(() => {
      const highlight = CSS.highlights?.get('compose-anchor');
      return highlight ? Array.from(highlight, range => range.toString()).join('').replace(/\s+/g, ' ').trim() : null;
    });
  }

  async function frameDraftHighlight(check) {
    return check.evaluate(() => {
      const frame = document.querySelector('.doc-frame');
      const win = frame?.contentWindow;
      const highlight = win?.CSS?.highlights?.get('compose-anchor');
      return highlight ? Array.from(highlight, range => range.toString()).join('').replace(/\s+/g, ' ').trim() : null;
    });
  }

  async function selectFirstPassageInFrame(check) {
    return check.evaluate(() => {
      const frame = document.querySelector('.doc-frame');
      const doc = frame.contentDocument;
      const paragraph = doc.querySelector('p');
      const text = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
      const range = doc.createRange();
      range.setStart(text, 0);
      range.setEnd(text, text.textContent.length);
      const selection = frame.contentWindow.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      doc.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return range.toString().replace(/\s+/g, ' ').trim();
    });
  }

  async function htmlPassageVisible(check, threadId = '') {
    return check.evaluate(id => {
      const frame = document.querySelector('.doc-frame');
      const anchor = frame?.contentDocument
        ? Array.from(frame.contentDocument.querySelectorAll('.dt-highlight')).find(element => !id || (element.dataset.threadIds || element.dataset.threadId || '').split(' ').includes(id))
        : null;
      if (!frame || !anchor) return false;
      const frameRect = frame.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      const top = frameRect.top + rect.top;
      const bottom = frameRect.top + rect.bottom;
      return top >= 0 && bottom <= innerHeight;
    }, threadId);
  }

  await scenario('keyboard selection, intent and narrow/zoomed layout', async check => {
    await check.goto(`${app}/?ui-check=signed-out`, { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Comments', exact: true }).waitFor();
    await check.locator('.doc').focus();
    await check.keyboard.down('Shift');
    for (let index = 0; index < 12; index += 1) await check.keyboard.press('ArrowRight');
    const selection = await check.evaluate(() => window.getSelection().toString());
    expect(Boolean(selection), 'Shift+Arrow selected no document text');
    await check.keyboard.up('Shift');
    const composer = check.getByRole('region', { name: 'New comment' });
    await composer.waitFor();
    await scan(check, 'open keyboard comment composer');
    expect((await composer.locator('.compose-quote').innerText()) === selection.trim(), 'Keyboard selection and anchor differ');
    expect((await draftHighlight(check)) === selection.trim(), 'Keyboard draft selection has no persistent highlight');
    await composer.locator('textarea').first().fill('Keyboard browser regression');
    await check.evaluate(() => window.getSelection().removeAllRanges());
    expect((await draftHighlight(check)) === selection.trim(), 'Moving focus to the composer lost the draft highlight');
    await check.getByRole('radio', { name: 'Question', exact: true }).focus();
    await check.keyboard.press('ArrowRight');
    await check.getByRole('button', { name: 'Post comment', exact: true }).focus();
    await check.keyboard.press('Enter');
    const thread = check.locator('.thread').filter({ hasText: 'Keyboard browser regression' });
    await thread.waitFor();
    expect((await thread.locator('.intent-badge').innerText()) === 'Suggestion', 'Keyboard intent was not retained');
    expect((await draftHighlight(check)) === null, 'Posting left a stale draft highlight');
    expect((await check.locator('.doc .dt-highlight.active').innerText()).trim() === selection.trim(), 'Posting lost the thread highlight');
    for (const dimensions of [{ width: 390, zoom: 1 }, { width: 1280, zoom: 2 }]) {
      await check.setViewportSize({ width: dimensions.width, height: 900 });
      await check.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, dimensions.zoom);
      const layout = await check.evaluate(() => ({ fits: document.documentElement.scrollWidth <= innerWidth + 1, overflow: getComputedStyle(document.querySelector('.gutter')).overflowY, source: getComputedStyle(document.querySelector('.source-context')).display }));
      expect(layout.fits && layout.overflow === 'visible' && layout.source !== 'none', 'Narrow/zoomed layout clips review content');
    }
  });

  await scenario('long comment quotes do not overlap labels or authors', async check => {
    await check.goto(route('quote-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const quote = 'Enable technical and non-technical contributors to review Markdown documents and make Markdown reviews accessible. '.repeat(8);
      fixture.markdown = `# Review fixture\n\n${quote}\n`;
      const original = fixture.remote.threads[0];
      fixture.remote.threads = ['question', 'blocking'].map(intent => ({
        ...original,
        id: `long-quote-${intent}`,
        intent,
        anchor: { quote: quote.trim(), prefix: '', suffix: '', start: 15 },
        comments: [{ id: `comment-${intent}`, author: 'LongReviewerName'.repeat(8), body: 'Please confirm the review requirements.', createdAt: original.createdAt }],
      }));
    });
    await openSource(check, source('long-quote-review'));
    await check.locator('[data-review-thread="long-quote-blocking"]').waitFor();
    for (const dimensions of [{ width: 1280, zoom: 1 }, { width: 390, zoom: 1 }, { width: 1280, zoom: 2 }]) {
      await check.setViewportSize({ width: dimensions.width, height: 900 });
      await check.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, dimensions.zoom);
      const cards = await check.locator('.thread').evaluateAll(threads => threads.map(thread => {
        const quote = thread.querySelector('.quote');
        const text = thread.querySelector('.quote-text');
        const labels = thread.querySelector('.thread-labels');
        const author = thread.querySelector('.comment .meta');
        return {
          clipped: getComputedStyle(text).overflowY === 'hidden' && text.scrollHeight > text.clientHeight && text.clientHeight <= 2 * parseFloat(getComputedStyle(text).lineHeight) + 1,
          stacked: quote.getBoundingClientRect().bottom <= labels.getBoundingClientRect().top + 1 && labels.getBoundingClientRect().bottom <= author.getBoundingClientRect().top + 1,
          contained: author.getBoundingClientRect().right <= thread.getBoundingClientRect().right + 1,
        };
      }));
      expect(cards.length === 2 && cards.every(card => card.clipped && card.stacked && card.contained), `Long quote overlaps card content at ${dimensions.width}px / ${dimensions.zoom}x`);
      expect(await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Long comment content overflows the viewport');
      await scan(check, `long comment quotes ${dimensions.width}px ${dimensions.zoom}x`);
    }
  });

  await scenario('unboxed intent and alias labels keep primary comment actions readable', async check => {
    await check.goto(route('card-labels-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const original = fixture.remote.threads[0];
      const verified = '@release_reviewer';
      const unverified = '@unknown_alias_for_release_planning';
      const body = `Please review ${verified} and ${unverified}.`;
      fixture.remote.threads = ['question', 'suggestion', 'blocking'].map(intent => ({
        ...original, id: `label-${intent}`, intent,
        comments: [{
          ...original.comments[0], id: `label-comment-${intent}`, body,
          mentions: [
            { kind: 'resolved', start: body.indexOf(verified), length: verified.length, text: verified, handle: verified.slice(1), subjectKey: 'github:U_release', identityKeys: ['github:U_release'], authority: 'github', displayName: 'Release Reviewer', route: { kind: 'github', nodeId: 'U_release' } },
            { kind: 'unresolved', start: body.indexOf(unverified), length: unverified.length, text: unverified, handle: unverified.slice(1) },
          ],
        }],
      }));
    });
    await openSource(check, source('card-labels'));
    await check.locator('[data-review-thread="label-blocking"]').waitFor();
    expect((await check.getByRole('menu').count()) === 0, 'Secondary actions are visible by default');
    expect((await check.getByRole('button', { name: /^(Copy link|Delete)$/ }).count()) === 0, 'Secondary actions remain on the card');
    for (const card of await check.locator('.thread').all()) {
      expect((await card.locator('.thread-primary-actions button').allTextContents()).join(',') === 'Reply,Resolve,Show passage', 'The three primary actions are not grouped together');
      expect((await card.locator('.mention.unresolved').innerText()) === '@unknown_alias_for_release_planning', 'The verified alias was marked unverified');
      expect((await card.locator('.waiting-badge.unresolved').innerText()).includes('Unverified'), 'Unverified aliases lack an explicit status label');
    }
    for (const dimensions of [
      { width: 1280, zoom: 1, theme: 'light' },
      { width: 390, zoom: 1, theme: 'light' },
      { width: 320, zoom: 1, theme: 'dark' },
      { width: 320, zoom: 1, theme: 'dark', font: 'monospace' },
      { width: 1280, zoom: 2, theme: 'dark' },
    ]) {
      await check.setViewportSize({ width: dimensions.width, height: 900 });
      await check.emulateMedia({ colorScheme: dimensions.theme });
      await check.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, dimensions.zoom);
      await check.locator('.thread-primary-actions button').evaluateAll((buttons, font) => {
        buttons.forEach(button => { button.style.fontFamily = font; });
      }, dimensions.font || '');
      const layout = await check.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= innerWidth + 1,
        viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
        labels: Array.from(document.querySelectorAll('.thread .intent-badge, .thread .waiting-badge, .thread .mention.unresolved')).every(label => {
          const style = getComputedStyle(label);
          return style.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(style.borderTopWidth) === 0 && parseFloat(style.borderBottomWidth) === 0;
        }),
        actions: Array.from(document.querySelectorAll('.thread-primary-actions button')).map(button => {
          const rect = button.getBoundingClientRect();
          const children = Array.from(button.children).map(child => {
            const childRect = child.getBoundingClientRect();
            return { tag: child.tagName, rect: childRect.toJSON(), fits: childRect.left >= rect.left && childRect.right <= rect.right + 1 && childRect.top >= rect.top && childRect.bottom <= rect.bottom + 1 };
          });
          return { text: button.textContent, rect: rect.toJSON(), children, fits: children.every(child => child.fits) };
        }),
      }));
      expect(layout.fits && layout.labels && layout.actions.every(action => action.fits), `Unboxed card labels/actions clip at ${dimensions.width}px, ${dimensions.zoom}x, ${dimensions.theme}: ${JSON.stringify(layout)}`);
      if (dimensions.font) {
        expect(layout.actions[2].rect.top > layout.actions[0].rect.top, 'A wide action label did not move its whole button to the next row');
      }
      const trigger = check.getByRole('button', { name: 'More actions for comment 1', exact: true });
      await trigger.click();
      const menu = check.getByRole('menu', { name: 'Actions for comment 1', exact: true });
      const bounds = await menu.boundingBox();
      expect(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= dimensions.width + 1 && bounds.y + bounds.height <= 901, 'Overflow menu escapes the viewport at mobile/zoom dimensions');
      await scan(check, `unboxed card actions ${dimensions.width}px ${dimensions.zoom}x ${dimensions.theme}${dimensions.font ? ' wide font' : ''}`);
      await check.keyboard.press('Escape');
    }
  });

  await scenario('comment overflow menu preserves focus, layout, copy fallback and deletion confirmation', async check => {
    await check.goto(route('card-menu'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.getByRole('button', { name: 'Show comment 1', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'fixture-thread');
    const card = check.locator('[data-review-thread="fixture-thread"]');
    const trigger = card.getByRole('button', { name: 'More actions for comment 1', exact: true });
    await trigger.focus();
    const before = await card.boundingBox();
    const scrollBefore = await check.evaluate(() => scrollY);
    await check.keyboard.press('ArrowDown');
    const menu = check.getByRole('menu', { name: 'Actions for comment 1', exact: true });
    await menu.waitFor();
    expect(await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).evaluate(element => element === document.activeElement), 'Menu does not focus the first item');
    const after = await card.boundingBox();
    expect(Math.abs(before.y - after.y) < 1 && Math.abs(before.height - after.height) < 1 && Math.abs((await check.evaluate(() => scrollY)) - scrollBefore) < 1, 'Opening the menu shifted its card or document');
    await check.keyboard.press('ArrowDown');
    expect(await menu.getByRole('menuitem', { name: 'Delete', exact: true }).evaluate(element => element === document.activeElement), 'ArrowDown did not reach Delete');
    await check.keyboard.press('Home');
    expect(await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).evaluate(element => element === document.activeElement), 'Home did not reach the first item');
    await check.keyboard.press('End');
    expect(await menu.getByRole('menuitem', { name: 'Delete', exact: true }).evaluate(element => element === document.activeElement), 'End did not reach the last item');
    await scan(check, 'comment action menu keyboard');
    await check.keyboard.press('Escape');
    expect(await trigger.evaluate(element => element === document.activeElement), 'Escape did not restore focus to the kebab button');
    await check.keyboard.press('ArrowUp');
    expect(await menu.getByRole('menuitem', { name: 'Delete', exact: true }).evaluate(element => element === document.activeElement), 'ArrowUp did not open at the last item');
    await check.keyboard.press('Tab');
    await menu.waitFor({ state: 'hidden' });
    await trigger.click();
    await check.locator('.doc h1').click();
    await menu.waitFor({ state: 'hidden' });
    await check.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.docThreadTest.copiedLink = value; } } });
    });
    const writesBefore = await check.evaluate(() => window.docThreadTest.calls.length);
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
    expect(await check.evaluate(() => new URL(window.docThreadTest.copiedLink).searchParams.get('thread') === 'fixture-thread'), 'Copy link did not retain the exact thread');
    expect((await check.evaluate(() => window.docThreadTest.calls.length)) === writesBefore, 'Copy link started a provider request');
    await check.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Synthetic clipboard denial'); }; });
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
    const fallback = check.getByRole('dialog', { name: 'Copy thread link', exact: true });
    await fallback.waitFor();
    expect((await fallback.getByLabel('Thread link', { exact: true }).inputValue()).includes('fixture-thread'), 'Clipboard fallback lost its thread link');
    await scan(check, 'comment link clipboard fallback');
    await fallback.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await trigger.evaluate(element => element === document.activeElement), 'Clipboard fallback did not return focus to More actions');
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    expect((await card.count()) === 1, 'Canceled Delete removed the thread');
    await check.getByLabel('Filter discussions').selectOption('all');
    await card.getByRole('button', { name: 'Resolve', exact: true }).click();
    await card.getByRole('button', { name: 'Reopen', exact: true }).click();
    await card.getByRole('button', { name: 'Reply', exact: true }).click();
    await card.locator('textarea').fill('Reply remains available beside Resolve and Show passage.');
    await card.getByRole('button', { name: 'Post reply', exact: true }).click();
    await card.getByText('Reply remains available beside Resolve and Show passage.', { exact: true }).waitFor();
    check.removeAllListeners('dialog');
    check.on('dialog', dialog => dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await card.waitFor({ state: 'hidden' });
    await menu.waitFor({ state: 'hidden' });
  });

  await scenario('read-only thread actions retain their permission boundaries', async check => {
    const url = source('read-only-menu').replace('/blob/main/', '/blob/v1/');
    await check.goto(`${app}/?ui-check=authorized&doc=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    const card = check.locator('[data-review-thread="fixture-thread"]');
    expect(await card.getByRole('button', { name: 'Resolve', exact: true }).isDisabled(), 'Read-only thread allows a shared status change');
    expect(await card.getByRole('button', { name: 'Reply', exact: true }).isEnabled(), 'Read-only review lost local commenting');
    expect(await card.getByRole('button', { name: 'Show passage', exact: true }).isEnabled(), 'Read-only review lost passage navigation');
    await card.getByRole('button', { name: 'More actions for comment 1', exact: true }).click();
    const menu = check.getByRole('menu', { name: 'Actions for comment 1', exact: true });
    expect(await menu.getByRole('menuitem', { name: 'Delete', exact: true }).isDisabled(), 'The overflow menu bypasses Delete permissions');
    await check.keyboard.press('End');
    expect(await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).evaluate(element => element === document.activeElement), 'Menu keyboard navigation did not skip disabled Delete');
    await scan(check, 'read-only comment action menu');
  });

  await scenario('passage alignment, numbered links and responsive review navigation', async check => {
    await check.goto(route('alignment-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const quotes = ['Confirm the rollout owner before deployment.', 'Define a recovery window for the service.', 'Record the rollback decision in the review.'];
      fixture.markdown = '# Review fixture\n\n' + 'Release context remains visible beside its discussions. '.repeat(20) + '\n\n' + quotes[0] + '\n\n' + 'The review includes operating requirements and recovery planning. '.repeat(35) + '\n\n' + quotes.slice(1).join('\n\n') + '\n';
      const original = fixture.remote.threads[0];
      fixture.remote.threads = quotes.map((quote, index) => ({
        ...original, id: `alignment-${index + 1}`,
        anchor: { quote, prefix: '', suffix: '', start: 1000 - index },
        comments: [{ ...original.comments[0], id: `aligned-comment-${index + 1}`, createdAt: `2026-09-09T10:0${index}:00.000Z` }],
      })).reverse();
    });
    await openSource(check, source('aligned-review'));
    await check.waitForFunction(() => {
      const card = document.querySelector('[data-review-thread="alignment-1"]');
      const anchor = document.querySelector('.doc-body [data-thread-id="alignment-1"]');
      return card && anchor && Math.abs(card.getBoundingClientRect().top - anchor.getClientRects()[0].top) < 2;
    });
    expect((await check.getByLabel('Sort discussions').inputValue()) === 'document', 'Document order is not the default');
    expect((await check.locator('.thread').evaluateAll(cards => cards.map(card => card.dataset.reviewThread).join(','))) === 'alignment-1,alignment-2,alignment-3', 'Cards follow stale offsets instead of the displayed passages');
    expect((await check.locator('.thread .comment-number').allTextContents()).join(',') === '1,2,3', 'Card numbers do not follow document order');
    await scan(check, 'aligned comments desktop');
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'alignment-2');
    expect(await check.locator('[data-passage-thread="alignment-2"].active').count() === 1, 'The passage marker and focused card are not paired');
    await check.getByRole('button', { name: 'Show passage for comment 1', exact: true }).click();
    expect(await check.locator('[data-review-thread="alignment-1"].active').count() === 1, 'The quoted passage control did not activate its own thread');
    const visibleAnchor = await check.locator('.doc-body [data-thread-id="alignment-1"]').evaluate(anchor => {
      const rect = anchor.getClientRects()[0];
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    expect(visibleAnchor, 'Show passage did not reveal the corresponding document text');
    const second = check.locator('[data-review-thread="alignment-2"]');
    await second.getByRole('button', { name: 'Reply', exact: true }).click();
    await second.locator('textarea').fill('An unsent reply stays with the same passage while the layout changes.');
    await check.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.thread')).map(card => card.getBoundingClientRect());
      return cards.every((card, index) => index === 0 || card.top >= cards[index - 1].bottom + 11);
    });
    for (const dimensions of [{ width: 1280, zoom: 2 }, { width: 900, zoom: 1 }, { width: 390, zoom: 1 }]) {
      await check.setViewportSize({ width: dimensions.width, height: 900 });
      await check.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, dimensions.zoom);
      await check.waitForFunction(() => {
        const doc = document.querySelector('.doc').getBoundingClientRect();
        const rail = document.querySelector('.thread-list').getBoundingClientRect();
        return doc.right <= rail.left + 1 || Array.from(document.querySelectorAll('[data-review-slot]')).every(card => Math.abs(parseFloat(card.style.getPropertyValue('--thread-offset')) || 0) < 0.5);
      });
      expect(await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Aligned review overflows the viewport');
      const markersFit = await check.locator('.passage-marker').evaluateAll(markers => markers.every((marker, index) => {
        const rect = marker.getBoundingClientRect();
        const anchor = Array.from(document.querySelectorAll('.doc-body [data-thread-id]')).find(span => span.getAttribute('data-thread-id') === marker.getAttribute('data-passage-thread'));
        return rect.left >= anchor.closest('p').getBoundingClientRect().right + 1 && (index === 0 || rect.top >= markers[index - 1].getBoundingClientRect().bottom + 1);
      }));
      expect(markersFit, 'Passage markers overlap document text or each other');
      await scan(check, `aligned comments ${dimensions.width}px ${dimensions.zoom}x`);
    }
    await check.setViewportSize({ width: 1280, height: 900 });
    await check.getByLabel('Sort discussions').selectOption('newest');
    await check.waitForFunction(() => {
      const normalFlow = !document.querySelector('.gutter').hasAttribute('data-focused-layout');
      const numbers = Array.from(document.querySelectorAll('.thread .comment-number')).map(number => number.textContent).join(',');
      const reset = Array.from(document.querySelectorAll('[data-review-slot]')).every(card => Math.abs(parseFloat(card.style.getPropertyValue('--thread-offset')) || 0) < 0.5);
      return normalFlow && reset && numbers === '3,2,1';
    });
    expect((await check.locator('.thread .comment-number').allTextContents()).join(',') === '3,2,1', 'Alternate sorting changed the passage numbers');
    expect((await second.locator('textarea').inputValue()).startsWith('An unsent reply'), 'Reordering lost the reply draft');
    await check.getByLabel('Search discussions').fill('recovery window');
    await check.waitForFunction(() => document.querySelectorAll('.thread').length === 1);
    expect((await check.locator('.thread .comment-number').innerText()) === '2', 'Filtering renumbered the passage');
    await check.getByRole('button', { name: 'Show comment 1', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'alignment-1');
    expect((await check.getByLabel('Search discussions').inputValue()) === '', 'A passage marker did not reveal its filtered-out card');
    await scan(check, 'numbered passage navigation after filtering');
  });

  await scenario('paired navigation is passive and respects the selected sort', async check => {
    await check.goto(route('navigation-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const original = fixture.remote.threads[0];
      fixture.markdown += '\n\n' + 'Additional release context below the discussion passage. '.repeat(40) + '\n';
      fixture.remote.threads = Array.from({ length: 3 }, (_, index) => ({
        ...original, id: `navigation-${index + 1}`, resolved: index === 1,
        comments: [{ ...original.comments[0], id: `navigation-comment-${index + 1}`, body: `Navigation discussion ${index + 1}.`, createdAt: `2026-09-09T10:0${index}:00.000Z` }],
      }));
    });
    await openSource(check, source('quiet-navigation'));
    await check.locator('[data-review-thread="navigation-3"]').waitFor();
    await check.getByLabel('Filter discussions').selectOption('all');
    await check.waitForFunction(() => Array.from(document.querySelectorAll('.thread .comment-number')).map(number => number.textContent).join(',') === '1,2,3');
    expect(await check.locator('[data-review-thread="navigation-2"] .thread-resolution').innerText() === 'Resolved', 'Resolved status disappeared when mixed into passage order');
    const marker = check.getByRole('button', { name: 'Show comment 1', exact: true });
    const first = check.locator('[data-review-thread="navigation-1"]');
    const geometry = () => check.evaluate(() => ({ scroll: scrollY, tops: Array.from(document.querySelectorAll('.thread')).map(card => card.getBoundingClientRect().top + scrollY) }));
    const before = await geometry();
    await marker.hover();
    await check.waitForFunction(() => document.querySelector('[data-review-thread="navigation-1"].paired') && document.querySelector('.doc-body .dt-highlight.paired'));
    expect(await check.locator('.thread.active').count() === 0, 'Hover selected a thread');
    await check.mouse.move(8, 8);
    await marker.focus();
    await check.waitForFunction(() => document.querySelector('[data-review-thread="navigation-1"].paired'));
    expect(JSON.stringify(await geometry()) === JSON.stringify(before), 'Hover or focus moved the page or repacked the rail');
    await check.getByRole('button', { name: 'Next comment', exact: true }).focus();
    await first.locator('.body').hover();
    await check.waitForFunction(() => document.querySelector('[data-passage-thread="navigation-1"].paired') && document.querySelector('.doc-body .dt-highlight.paired'));
    expect(JSON.stringify(await geometry()) === JSON.stringify(before), 'Hovering a card moved its passage');
    expect(await check.getByRole('button', { name: 'Previous comment', exact: true }).isDisabled(), 'Previous should be unavailable before selecting a thread');
    await check.getByRole('button', { name: 'Next comment', exact: true }).press('Enter');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-1');
    await check.getByRole('button', { name: 'Next comment', exact: true }).press('Enter');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-2');
    await check.getByRole('button', { name: 'Previous comment', exact: true }).press('Enter');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-1');
    await first.getByRole('button', { name: 'Show passage', exact: true }).click();
    await check.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await check.locator('.return-to-comment').count() === 0, 'An already visible pair gained an unnecessary return action');
    await scan(check, 'quiet paired navigation desktop');
    await check.getByLabel('Sort discussions').selectOption('newest');
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-2');
    expect((await check.locator('.thread .comment-number').allTextContents()).join(',') === '3,2,1', 'Selecting a comment overrode the chosen sort');
    expect(await check.locator('.gutter[data-focused-layout]').count() === 0, 'Alternate sorting still uses passage alignment');
    await check.getByLabel('Sort discussions').selectOption('document');
    await check.getByLabel('Search discussions').fill('Navigation discussion 3');
    await check.getByRole('button', { name: 'Next comment', exact: true }).press('Enter');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-3');
    expect(await check.getByRole('button', { name: 'Next comment', exact: true }).isDisabled(), 'Next escaped the visible filtered list');
    expect(await check.getByRole('button', { name: 'Previous comment', exact: true }).isDisabled(), 'Previous escaped the visible filtered list');
    expect(await check.getByLabel('Search discussions').inputValue() === 'Navigation discussion 3', 'Traversal cleared the active search');
    await check.getByLabel('Search discussions').fill('');
    const third = check.locator('[data-review-thread="navigation-3"]');
    for (const dimensions of [{ width: 390, zoom: 1, theme: 'light' }, { width: 320, zoom: 1, theme: 'dark' }, { width: 1280, zoom: 2, theme: 'dark' }]) {
      await check.setViewportSize({ width: dimensions.width, height: 900 });
      await check.emulateMedia({ colorScheme: dimensions.theme });
      await check.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, dimensions.zoom);
      await third.getByRole('button', { name: 'Show passage', exact: true }).click();
      const back = check.getByRole('button', { name: 'Back to comment 3', exact: true });
      await check.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const alreadyVisible = await third.locator('.quote').evaluate(quote => { const rect = quote.getBoundingClientRect(); return rect.top >= 12 && rect.bottom <= innerHeight - 12; });
      if (dimensions.width < 900) expect(!alreadyVisible, 'The mobile return witness did not put the card off-screen');
      expect(await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Passage navigation overflowed the viewport');
      if (alreadyVisible) {
        await back.waitFor({ state: 'hidden' });
      } else {
        await back.waitFor();
        const visible = await back.evaluate(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1; });
        expect(visible, 'The return action is outside the viewport');
      }
      await scan(check, `passage return ${dimensions.width}px ${dimensions.zoom}x ${dimensions.theme}`);
      if (alreadyVisible) await check.getByRole('button', { name: 'Show comment 3', exact: true }).evaluate(button => button.click());
      else await back.press('Enter');
      await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'navigation-3');
      await back.waitFor({ state: 'hidden' });
      const quoteVisible = await third.locator('.quote').evaluate(quote => { const rect = quote.getBoundingClientRect(); return rect.top >= -1 && rect.bottom <= innerHeight + 1; });
      expect(quoteVisible, 'Back to comment did not reveal the correct card');
      expect((await check.locator('.thread .comment-number').allTextContents()).join(',') === '1,2,3', 'Responsive navigation reordered the cards');
    }
  });

  await scenario('crowded comments keep numerical order and use the closest available row', async check => {
    await check.goto(route('crowded-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const original = fixture.remote.threads[0];
      const quotes = [original.anchor.quote, 'Keep the recovery window short.', 'Confirm the final release owner.'];
      fixture.markdown = '# Review fixture\n\n' + quotes.join('\n\n') + '\n';
      fixture.remote.threads = Array.from({ length: 8 }, (_, index) => ({
        ...original, id: `crowded-${index + 1}`,
        anchor: { quote: quotes[Math.max(0, index - 5)], prefix: '', suffix: '', start: index },
        comments: [{ ...original.comments[0], id: `crowded-comment-${index + 1}`, body: `Discussion ${index + 1} requires its own reply and passage link.` }],
      }));
    });
    await openSource(check, source('crowded-review'));
    await check.getByRole('button', { name: 'Show comment 8', exact: true }).waitFor();
    let scrollBefore = await check.evaluate(() => scrollY);
    const selected = check.locator('[data-review-thread="crowded-6"]');
    const ordered = async id => {
      await check.waitForFunction(id => {
        const anchor = Array.from(document.querySelectorAll('.doc-body [data-thread-id]')).find(span => (span.dataset.threadIds || span.dataset.threadId).split(' ').includes(id));
        const elements = Array.from(document.querySelectorAll('.thread'));
        const index = elements.findIndex(element => element.dataset.reviewThread === id);
        if (!anchor || index < 0 || !document.querySelector('.gutter[data-focused-layout]')) return false;
        const list = document.querySelector('.thread-list').getBoundingClientRect();
        const cards = elements.map(element => element.getBoundingClientRect());
        const minimumTop = cards.slice(0, index).reduce((top, card) => top + card.height + 12, list.top);
        const expectedTop = Math.max(anchor.getClientRects()[0].top, minimumTop);
        return Math.abs(cards[index].top - expectedTop) < 2 && cards.every((rect, position) => position === 0 || rect.top >= cards[position - 1].bottom + 11);
      }, id);
      expect((await check.locator('.thread .comment-number').allTextContents()).join(',') === '1,2,3,4,5,6,7,8', 'Selection changed numerical reading order');
      expect((await check.locator('.passage-marker').allTextContents()).join(',') === '1,2,3,4,5,6,7,8', 'Selection reordered passage markers');
    };
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'crowded-2');
    await ordered('crowded-2');
    expect(Math.abs((await check.evaluate(() => scrollY)) - scrollBefore) < 2, 'Selecting an already visible pair moved the document');
    await check.getByRole('button', { name: 'Show comment 6', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'crowded-6');
    await ordered('crowded-6');
    expect(await selected.locator('.quote').evaluate(quote => { const rect = quote.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), 'Selecting an off-screen card did not reveal it');
    expect(await check.locator('.passage-connector').count() === 1, 'The displaced active pair has no connector');
    scrollBefore = await check.evaluate(() => scrollY);
    await check.getByRole('button', { name: 'Show comment 6', exact: true }).evaluate(button => button.click());
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'crowded-6');
    expect(Math.abs((await check.evaluate(() => scrollY)) - scrollBefore) < 2, 'Re-selecting a visible card recentered the document');
    await scan(check, 'crowded selection numerical order');
    await selected.getByRole('button', { name: 'Reply', exact: true }).click();
    await selected.locator('textarea').fill('This reply must survive movement within the comment stack.');
    await selected.locator('textarea').evaluate(input => { input.style.height = '180px'; });
    await ordered('crowded-6');
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).click();
    await ordered('crowded-2');
    await check.getByRole('button', { name: 'Show comment 6', exact: true }).click();
    await ordered('crowded-6');
    expect((await selected.locator('textarea').inputValue()).startsWith('This reply must survive'), 'Packing discarded a reply draft');
    await scan(check, 'crowded selection expanded reply');
    await selected.getByRole('button', { name: 'Show passage', exact: true }).click();
    scrollBefore = await check.evaluate(() => scrollY);
    await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
    const composer = check.getByRole('region', { name: 'New comment' });
    await check.waitForFunction(() => {
      const highlight = CSS.highlights.get('compose-anchor');
      const composer = document.querySelector('.review-composer');
      if (!highlight || !composer || !composer.contains(document.activeElement)) return false;
      const range = Array.from(highlight)[0];
      return Math.abs(range.getClientRects()[0].top - composer.getBoundingClientRect().top) < 2;
    });
    expect(Math.abs((await check.evaluate(() => scrollY)) - scrollBefore) < 2, 'Opening a draft scrolled away from its passage');
    await composer.locator('textarea').first().fill('A new comment beside the selected passage.');
    await scan(check, 'crowded draft ordered stack');
    await composer.locator('textarea').first().fill('');
    await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await composer.waitFor({ state: 'hidden' });
    expect((await selected.locator('textarea').inputValue()).startsWith('This reply must survive'), 'Canceling the aligned composer discarded another thread draft');
    await check.getByRole('button', { name: 'Show comment 8', exact: true }).click();
    await ordered('crowded-8');
    await scan(check, 'crowded selection later passage');
    await check.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).evaluate(button => button.click());
    await check.waitForFunction(() => {
      const anchor = document.querySelector('.doc-body [data-thread-id]');
      const card = document.querySelector('[data-review-thread="crowded-2"]');
      const top = anchor.getClientRects()[0].top;
      return top >= -1 && card.getBoundingClientRect().bottom <= innerHeight + 1 && document.activeElement === card;
    });
    await scan(check, 'off-screen selection reveals passage and card together');
    await check.locator('.doc h1').evaluate(heading => { heading.style.marginBottom = '1000px'; });
    await check.waitForFunction(() => {
      const anchor = document.querySelector('.doc-body [data-thread-id]');
      const card = document.querySelector('[data-review-thread="crowded-2"]');
      return Math.abs(anchor.getClientRects()[0].top - card.getBoundingClientRect().top) < 2;
    });
    await check.evaluate(() => window.scrollTo(0, scrollY + document.querySelector('.doc-body [data-thread-id]').getClientRects()[0].top - 180));
    scrollBefore = await check.evaluate(() => scrollY);
    expect(scrollBefore > 500, 'The scrolled-selection witness did not leave the top of the page');
    await check.getByRole('button', { name: 'Show comment 6', exact: true }).click();
    await ordered('crowded-6');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'crowded-6');
    await scan(check, 'crowded selection after document scroll');
  });

  await scenario('mouse and multi-block draft highlights follow the composer', async check => {
    await check.goto(route('highlight-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      window.docThreadTest.markdown = '# Review fixture\n\nThe release plan needs a **documented rollback**.\n\nReview by Friday.\n';
    });

    await scenario('HTML comments highlight, show passage, and apply suggestions to draft', async check => {
      await check.goto(route('html-controls'), { waitUntil: 'domcontentloaded' });
      await openSource(check, htmlSource('html-controls'));
      await check.frameLocator('.doc-frame').getByRole('heading', { name: 'HTML review fixture', exact: true }).waitFor();
      const quote = await selectFirstPassageInFrame(check);
      const composer = check.getByRole('region', { name: 'New comment' });
      await composer.waitFor();
      expect((await frameDraftHighlight(check)) === quote, 'HTML selection has no draft highlight');
      await composer.getByLabel('Suggest an edit', { exact: true }).check();
      await composer.getByLabel('Proposed replacement text', { exact: true }).fill('The release plan includes an approved rollback.');
      await composer.getByRole('button', { name: 'Post suggestion', exact: true }).click();
      const card = check.locator('.thread').filter({ hasText: 'Suggested change' });
      await card.waitFor();
      const threadId = await card.getAttribute('data-review-thread');
      expect(Boolean(threadId), 'HTML suggestion thread has no id');
      expect(await htmlPassageVisible(check, threadId), 'Posted HTML suggestion has no visible passage highlight');
      await check.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await card.getByRole('button', { name: 'Show passage', exact: true }).click();
      await check.waitForFunction(id => {
        const frame = document.querySelector('.doc-frame');
        const anchor = frame?.contentDocument
          ? Array.from(frame.contentDocument.querySelectorAll('.dt-highlight')).find(element => (element.dataset.threadIds || element.dataset.threadId || '').split(' ').includes(id))
          : null;
        if (!frame || !anchor) return false;
        const frameRect = frame.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        return frameRect.top + rect.top >= 0 && frameRect.top + rect.bottom <= innerHeight;
      }, threadId);
      await card.getByRole('button', { name: 'Apply to draft', exact: true }).click();
      await check.frameLocator('.doc-frame').getByText('approved rollback').waitFor();
      await check.getByLabel('Filter discussions').selectOption('all');
      expect(await check.locator(`[data-review-thread="${threadId}"]`).getByText('Suggested change applied to draft', { exact: true }).count() > 0, 'HTML suggestion was not marked applied');
    });

    await scenario('loaded GitHub Markdown and ADO descriptions keep comment creation enabled', async check => {
      await check.goto(route('loaded-commenting'), { waitUntil: 'domcontentloaded' });
      await openSource(check, source('loaded-commenting'));
      await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
      await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
      await check.getByRole('region', { name: 'New comment' }).waitFor();
      await check.getByRole('button', { name: 'Cancel', exact: true }).click();

      await check.goto(`${ado}/?ui-check=ado-commenting&doc=${encodeURIComponent('https://dev.azure.com/example/Docs/_workitems/edit/42')}`, { waitUntil: 'domcontentloaded' });
      await check.getByRole('heading', { name: 'ADO recovery fixture', exact: true }).waitFor();
      await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
      await check.getByRole('region', { name: 'New comment' }).waitFor();
    });
    await openSource(check, source('draft-highlights'));
    await check.locator('.doc strong').waitFor();
    await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
    const composer = check.getByRole('region', { name: 'New comment' });
    await composer.waitFor();
    expect((await draftHighlight(check)) === (await composer.locator('.compose-quote').innerText()).trim(), 'Mouse selection has no draft highlight');
    const passage = await check.evaluate(() => {
      const paragraphs = document.querySelectorAll('.doc-body p');
      const range = document.createRange();
      const first = document.createTreeWalker(paragraphs[0], NodeFilter.SHOW_TEXT).nextNode();
      const last = document.createTreeWalker(paragraphs[1], NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('.doc').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return range.toString().replace(/\s+/g, ' ').trim();
    });
    const quote = (await composer.locator('.compose-quote').innerText()).replace(/\s+/g, ' ').trim();
    expect(quote === passage && (await draftHighlight(check)) === passage, 'Replacing a blank draft did not highlight the full formatted passage');
    await composer.locator('textarea').first().fill('Keep this passage highlighted');
    await check.evaluate(() => window.getSelection().removeAllRanges());
    expect((await draftHighlight(check)) === passage, 'The formatted draft highlight was lost on focus');
    expect(await check.locator('.doc strong .dt-highlight').count() > 0, 'The draft removed the existing thread highlight');
    await scan(check, 'persistent formatted draft selection');
    await check.locator('.doc h1').dblclick();
    expect((await draftHighlight(check)) === passage, 'A new selection moved an unsent comment to another passage');
    await composer.locator('textarea').first().fill('');
    const cancel = composer.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await cancel.press('Enter');
    await composer.waitFor({ state: 'hidden' });
    expect((await draftHighlight(check)) === null, 'Cancel left a stale draft highlight');
    expect(await check.locator('.doc .dt-highlight').count() > 0, 'Cancel removed posted thread highlights');
  });

  await scenario('overlapping, resolved and orphaned passages retain distinct links', async check => {
    await check.goto(route('shared-anchor-setup'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.evaluate(() => {
      const fixture = window.docThreadTest;
      const original = fixture.remote.threads[0];
      fixture.remote.threads = [
        original,
        { ...original, id: 'shared-passage', intent: 'blocking', comments: [{ ...original.comments[0], id: 'shared-comment', body: 'Second discussion on the same passage.' }] },
        { ...original, id: 'resolved-passage', resolved: true, comments: [{ ...original.comments[0], id: 'resolved-comment' }] },
        { ...original, id: 'orphan-passage', anchor: { quote: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', prefix: '', suffix: '', start: 0 }, comments: [{ ...original.comments[0], id: 'orphan-comment' }] },
      ];
    });
    await openSource(check, source('shared-anchor-review'));
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).waitFor();
    expect((await check.locator('.passage-marker').count()) === 3, 'An orphan has a marker or a located thread is missing one');
    expect(await check.getByRole('button', { name: 'Show passage for comment 4', exact: true }).isDisabled(), 'The orphan quote links to unrelated text');
    const numbered = await check.locator('.passage-marker').evaluateAll(markers => markers.every((marker, index) => index === 0 || marker.getBoundingClientRect().top >= markers[index - 1].getBoundingClientRect().bottom + 1));
    expect(numbered, 'Shared passage markers overlap each other');
    await check.getByRole('button', { name: 'Show comment 2', exact: true }).focus();
    await check.keyboard.press('Enter');
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'shared-passage');
    expect(await check.locator('.doc-body .dt-highlight.multi.active').count() > 0, 'The second shared thread does not activate its shared passage');
    await check.getByRole('button', { name: 'Show comment 3', exact: true }).click();
    await check.waitForFunction(() => document.activeElement?.getAttribute('data-review-thread') === 'resolved-passage');
    expect((await check.getByLabel('Filter discussions').inputValue()) === 'all', 'Resolved marker did not reveal the resolved thread');
    await check.emulateMedia({ colorScheme: 'dark' });
    await scan(check, 'shared passage comments dark');
    await check.setViewportSize({ width: 320, height: 900 });
    await scan(check, 'shared passage comments dark 320px');
    expect(await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Shared passages overflow at 320px');
    await check.getByLabel('Filter discussions').selectOption('needs-reanchor');
    expect((await check.locator('.thread').count()) === 1, 'Needs re-anchor filter lost the orphan');
    expect((await check.locator('.thread .comment-number').innerText()) === '4', 'The orphan was renumbered after filtering');
  });

  await scenario('draft alignment preserves mouse cancel and quoted source text', async check => {
    await check.goto(route('draft-alignment'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
    const composer = check.getByRole('region', { name: 'New comment' });
    await composer.waitFor();
    const quote = (await composer.locator('.compose-quote').innerText()).trim();
    expect(!/\d/.test(quote), 'A passage marker entered the selection anchor');
    await composer.locator('textarea').first().fill('Keep the original passage');
    await check.locator('.doc h1').dblclick();
    expect((await draftHighlight(check)) === quote, 'Reselecting text changed an unsent draft anchor');
    await composer.locator('textarea').first().fill('');
    await composer.getByRole('button', { name: 'Cancel', exact: true }).click();
    await composer.waitFor({ state: 'hidden' });
    expect((await draftHighlight(check)) === null, 'Mouse cancel left the draft highlight behind');
    await check.locator('.doc p').last().dblclick({ position: { x: 20, y: 10 } });
    await composer.waitFor();
    await composer.locator('textarea').first().fill('The current draft remains highlighted');
    await check.evaluate(() => window.getSelection().removeAllRanges());
    expect((await check.locator('.thread.active, .passage-marker.active, .doc-body .dt-highlight.active').count()) === 0, 'An old thread still competes with the composing selection');
    await scan(check, 'aligned draft desktop');
    await check.setViewportSize({ width: 390, height: 900 });
    expect((await draftHighlight(check)) === (await composer.locator('.compose-quote').innerText()).trim(), 'Narrow reflow lost the composing highlight');
    await scan(check, 'aligned draft mobile');
  });

  await scenario('document draft exit, reload, access and matching-save cleanup', async check => {
    await check.goto(route('document-recovery'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await openEditor(check);
    const draft = (await check.locator('.editor-input').inputValue()) + '\nDraft kept through source failure.\n';
    await check.locator('.editor-input').fill(draft);
    await scan(check, 'unsaved document editor');
    await check.waitForFunction(() => document.body.textContent.includes('Document draft saved in this browser'));
    await check.getByRole('button', { name: 'Exit editor', exact: true }).click();
    await check.reload({ waitUntil: 'domcontentloaded' });
    await check.getByRole('button', { name: 'Compare draft', exact: true }).click();
    const recovered = check.getByRole('dialog', { name: 'Document draft', exact: true });
    await scan(check, 'document recovery comparison dialog');
    expect((await recovered.getByRole('textbox', { name: 'Recovered draft', exact: true }).inputValue()) === draft, 'Reload changed draft content');
    expect(!(await recovered.getByRole('textbox', { name: 'Current source', exact: true }).inputValue()).includes('Draft kept'), 'Draft silently replaced current source');
    await recovered.getByRole('button', { name: 'Restore draft', exact: true }).click();
    await check.evaluate(() => { window.docThreadTest.mode = 'document-failed'; });
    await check.getByRole('button', { name: 'Apply draft', exact: true }).click();
    const save = check.getByRole('dialog', { name: 'Save your edits to GitHub', exact: true });
    await scan(check, 'source-save confirmation dialog');
    await save.getByRole('button', { name: /Commit to/ }).click();
    await check.waitForFunction(() => document.querySelector('dialog[open]').textContent.includes('Commit failed'));
    expect((await check.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('docthread:document-draft:')).length)) === 1, 'Failed source save removed recovery');
    await save.getByRole('button', { name: 'Keep in this tab', exact: true }).click();
    await check.goto(route('document-recovery', 'private-denied'), { waitUntil: 'domcontentloaded' });
    await check.locator('.source-problem').waitFor();
    expect((await check.getByRole('button', { name: 'Compare draft', exact: true }).count()) === 0, 'Denied source exposed a recovery draft');
    await check.goto(route('document-recovery'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('button', { name: 'Compare draft', exact: true }).click();
    await check.getByRole('button', { name: 'Restore draft', exact: true }).click();
    await check.getByRole('button', { name: 'Apply draft', exact: true }).click();
    await check.getByRole('dialog', { name: 'Save your edits to GitHub', exact: true }).getByRole('button', { name: /Commit to/ }).click();
    await check.waitForFunction(() => !document.querySelector('dialog[open]'));
    expect((await check.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('docthread:document-draft:')).length)) === 0, 'Confirmed source save kept a stale draft');
  });

  await scenario('reverting an edit does not restore an obsolete draft', async check => {
    await check.goto(route('reverted-edit'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await openEditor(check);
    const original = await check.locator('.editor-input').inputValue();
    await check.locator('.editor-input').fill(original + '\nTemporary change, then undo.\n');
    await check.waitForFunction(() => document.body.textContent.includes('Document draft saved in this browser'));
    await check.locator('.editor-input').fill(original);
    await check.reload({ waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    expect((await check.getByRole('button', { name: 'Compare draft', exact: true }).count()) === 0, 'An undone edit was offered as a recovery draft');
  });

  await scenario('unposted comments and replies remain with their source', async check => {
    await check.goto(route('draft-first'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    const thread = check.locator('[data-review-thread="fixture-thread"]');
    await thread.getByRole('button', { name: 'Reply', exact: true }).click();
    await thread.locator('textarea').fill('Unsent reply for first source');
    await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
    await check.locator('.review-composer textarea').first().fill('Unsent comment for first source');
    const originalHighlight = await draftHighlight(check);
    expect(Boolean(originalHighlight), 'The first source draft has no highlight');
    await openSource(check, source('draft-second'));
    await scan(check, 'unsaved-input source-switch dialog');
    await check.getByRole('button', { name: 'Keep drafts and continue', exact: true }).click();
    await check.waitForFunction(() => document.querySelector('.source-context').textContent.includes('draft-second'));
    expect((await check.getByRole('region', { name: 'New comment' }).count()) === 0, 'Unsent comment transferred to second source');
    expect((await draftHighlight(check)) === null, 'The first source draft highlight leaked into the second source');
    await openSource(check, source('draft-first'));
    await check.waitForFunction(() => document.querySelector('.source-context').textContent.includes('draft-first'));
    expect((await check.locator('.review-composer textarea').first().inputValue()) === 'Unsent comment for first source', 'First source comment lost');
    expect((await draftHighlight(check)) === originalHighlight, 'Returning to the source did not restore its draft highlight');
    expect((await check.locator('[data-review-thread="fixture-thread"] textarea').inputValue()) === 'Unsent reply for first source', 'First source reply lost');
    expect((await check.evaluate(() => window.docThreadTest.calls.filter(call => ['PUT', 'PATCH'].includes(call.method)).length)) === 0, 'Draft switching wrote the source');
  });

  await scenario('suggestions preserve unapplied drafts and provenance', async check => {
    await check.goto(route('suggestion-review', 'suggestion'), { waitUntil: 'domcontentloaded' });
    await check.getByRole('heading', { name: 'Review fixture', exact: true }).waitFor();
    await openEditor(check);
    const draft = (await check.locator('.editor-input').inputValue()) + '\nAn unapplied manual edit.\n';
    await check.locator('.editor-input').fill(draft);
    const apply = check.getByRole('button', { name: 'Apply to draft', exact: true });
    expect(await apply.isDisabled(), 'A suggestion can overwrite the unapplied editor draft');
    await check.getByRole('button', { name: 'Exit editor', exact: true }).click();
    expect(await apply.isDisabled(), 'A suggestion can overwrite a retained unapplied draft');
    await check.getByRole('button', { name: 'Compare draft', exact: true }).click();
    expect((await check.getByRole('textbox', { name: 'Recovered draft', exact: true }).inputValue()) === draft, 'Unapplied draft changed');
    await check.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await apply.click();
    const save = check.getByRole('dialog', { name: 'Save your edits to GitHub', exact: true });
    await save.waitFor();
    expect((await check.evaluate(() => window.docThreadTest.calls.filter(call => call.method === 'PUT').length)) === 0, 'Suggestion wrote the document without confirmation');
    await save.getByRole('button', { name: 'Keep in this tab', exact: true }).click();
    await check.waitForFunction(() => window.docThreadTest.remote.threads[0].suggestion?.appliedAt);
    const suggestion = await check.evaluate(() => window.docThreadTest.remote.threads[0].suggestion);
    expect(suggestion.origin === 'ai' && suggestion.skillName === 'Release checklist', 'Applying a suggestion lost its provenance');
  });

  for (const store of ['attachment', 'discussion']) {
    await scenario(`ADO ${store}: failed save, two-copy recovery, explicit save and read failure`, async check => {
      const url = `${ado}/?ui-check=ado&case=${store}&doc=${encodeURIComponent('https://dev.azure.com/example/Docs/_workitems/edit/42')}`;
      await check.goto(url, { waitUntil: 'domcontentloaded' });
      await check.getByRole('heading', { name: 'ADO recovery fixture', exact: true }).waitFor();
      await check.locator('.doc p').first().dblclick({ position: { x: 20, y: 10 } });
      await check.locator('.review-composer textarea').first().fill('Initial ADO feedback');
      await check.getByRole('button', { name: 'Post comment', exact: true }).click();
      await check.waitForFunction(() => document.querySelector('.review-storage').textContent.includes('Feedback saved to ADO'));
      await check.evaluate(() => { window.docThreadTest.mode = 'ado-save-failed'; });
      const thread = check.locator('.thread').first();
      await thread.getByRole('button', { name: 'Reply', exact: true }).click();
      await thread.locator('textarea').fill('Local feedback after failure');
      await thread.getByRole('button', { name: 'Post reply', exact: true }).click();
      await check.getByRole('button', { name: 'Retry feedback save', exact: true }).waitFor();
      await check.evaluate(store => {
        const shared = window.docThreadTest.ado[store];
        shared.threads[0].comments.push({ id: 'concurrent-shared', author: 'Other reviewer', body: 'Concurrent shared feedback', createdAt: '2026-09-09T10:00:00.000Z' });
        if (store === 'discussion') window.docThreadTest.ado.discussionText = '<div style="display:none">docthread-review:v1 ' + btoa(unescape(encodeURIComponent(JSON.stringify(shared)))) + '</div>';
        window.docThreadTest.persistAdo();
      }, store);
      await check.reload({ waitUntil: 'domcontentloaded' });
      await check.getByRole('button', { name: 'Compare feedback', exact: true }).click();
      expect(await check.getByRole('button', { name: 'Save review', exact: true, includeHidden: true }).isDisabled(), 'Unreconciled ADO feedback can be blindly saved');
      const dialog = check.getByRole('dialog', { name: 'Local and saved feedback', exact: true });
      await scan(check, `${store} feedback recovery dialog`);
      expect((await dialog.getByRole('textbox', { name: 'Local feedback copy' }).inputValue()).includes('Local feedback after failure'), 'Local ADO copy was lost');
      expect((await dialog.getByRole('textbox', { name: 'Saved feedback copy' }).inputValue()).includes('Concurrent shared feedback'), 'Shared ADO copy was lost');
      await dialog.getByRole('button', { name: 'Combine feedback locally', exact: true }).click();
      expect((await check.evaluate(() => window.docThreadTest.calls.filter(call => ['POST', 'PATCH'].includes(call.method)).length)) === 0, 'Recovery published without confirmation');
      await check.getByRole('button', { name: 'Save review', exact: true }).click();
      await check.waitForFunction(() => document.querySelector('.review-storage').textContent.includes('Feedback saved to ADO'));
      const bodies = await check.evaluate(store => window.docThreadTest.ado[store].threads[0].comments.map(comment => comment.body), store);
      expect(bodies.includes('Local feedback after failure') && bodies.includes('Concurrent shared feedback'), 'Combined save dropped feedback');
      await check.goto(url.replace('ui-check=ado', 'ui-check=ado-read-failed'), { waitUntil: 'domcontentloaded' });
      await check.getByRole('button', { name: 'Retry reading feedback', exact: true }).waitFor();
      expect(await check.getByRole('button', { name: 'Save review', exact: true }).isDisabled(), 'Read failure allows a blind save');
      await check.evaluate(() => { window.docThreadTest.mode = 'ado'; });
      await check.getByRole('button', { name: 'Retry reading feedback', exact: true }).click();
      await check.getByRole('button', { name: 'Retry reading feedback', exact: true }).waitFor({ state: 'hidden' });
    }, store);
  }
  return results;
}
