(() => {
  const nativeFetch = window.fetch.bind(window);
  const scene = new URLSearchParams(location.search).get('ui-check') || 'authorized';
  const adoFixtureKey = 'docthread-test:ado:' + (new URLSearchParams(location.search).get('case') || 'default');
  const createdAt = '2026-09-09T10:00:00.000Z';
  const quote = 'The release plan needs a documented rollback.';
  const markdown = `# Review fixture\n\n${quote}\n\n## Timing\n\nReview by Friday.\n`;
  const html = `<!doctype html><html><head><title>HTML review fixture</title></head><body><h1>HTML review fixture</h1><p>${quote}</p><p>Review by Friday.</p></body></html>`;
  const fixture = {
    mode: scene,
    signedIn: scene !== 'signed-out',
    identity: { login: 'fixture_reviewer', name: 'UI fixture reviewer', nodeId: 'U_fixture' },
    reviewFindings: [
      { quote, title: 'Fixture post', rationale: 'A posted decision.', pass: 'compliance', severity: 'important', intent: 'question' },
      { quote, title: 'Fixture apply', rationale: 'A combined decision.', pass: 'security', severity: 'important', intent: 'suggestion', replacement: 'Completely unrelated wording replaces this entire paragraph.' },
      { quote, title: 'Fixture stale', rationale: 'A stale replacement.', pass: 'security', severity: 'important', intent: 'suggestion', replacement: 'The release plan needs an approved rollback.' },
      { quote, title: 'Fixture dismiss', rationale: 'A dismissed decision.', pass: 'custom-free-text-pass', severity: 'important', intent: 'question' },
    ],
    holdReview: false,
    reviewReleases: [],
    calls: [],
    unexpected: [],
    releaseSave: null,
    remote: {
      schemaVersion: 2,
      source: { provider: 'github', path: 'docs/review.md' },
      docPath: 'docs/review.md',
      updatedAt: createdAt,
      threads: [{
        id: 'fixture-thread',
        anchor: { quote, prefix: '', suffix: '', start: 15 },
        resolved: false,
        createdAt,
        intent: 'question',
        clocks: { resolutionAt: createdAt, intentAt: createdAt, anchorAt: createdAt },
        comments: [{ id: 'fixture-comment', author: 'Alex', body: 'Is the rollback tested?', createdAt, identityVersion: 1, authorIdentityKeys: ['github:U_alex'], authorLogin: 'alex', mentions: [] }],
      }],
    },
    markdown,
    html,
    pendingFile: null,
    refReads: 0,
    ado: JSON.parse(sessionStorage.getItem(adoFixtureKey) || 'null') || { attachment: null, discussion: null, discussionText: '', title: 'ADO recovery fixture', description: `<p>${quote}</p>`, revision: 1 },
    adoPending: null,
  };
  if (scene === 'suggestion') {
    fixture.remote.threads[0].suggestion = {
      replacement: 'The release plan needs a tested rollback.',
      origin: 'ai',
      skillName: 'Release checklist',
    };
  }
  fixture.persistAdo = () => sessionStorage.setItem(adoFixtureKey, JSON.stringify(fixture.ado));
  window.docThreadTest = fixture;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const encoded = text => btoa(unescape(encodeURIComponent(text)));
  const revision = () => (++fixture.refReads).toString(16).padStart(40, 'a');
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    const method = (options.method || input.method || 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname);
    if (path === '/auth/status') return json(fixture.signedIn ? { authenticated: true, ...fixture.identity } : { authenticated: false });
    if (path === '/auth/login' && scene.startsWith('insights')) {
      fixture.signedIn = true;
      return json({ authenticated: true, ...fixture.identity });
    }
    if (path === '/ado-auth/status') return json(scene.startsWith('ado') ? { authenticated: true, login: 'ado_fixture', name: 'ADO fixture author' } : { authenticated: false });
    if (path === '/auth/logout') { fixture.signedIn = false; return json({ ok: true }); }
    if (path === '/api/test-review') {
      fixture.calls.push({ method, path });
      const payload = { findings: structuredClone(fixture.reviewFindings) };
      if (fixture.holdReview) return new Promise(resolve => fixture.reviewReleases.push(() => resolve(json(payload))));
      return json(payload);
    }
    if (path === '/api/notify') {
      fixture.calls.push({ method, path });
      return json(fixture.mode === 'email-accepted' ? { delivered: true } : { delivered: false, reason: 'Simulated relay failure' });
    }
    if (path.startsWith('/ado-api/')) {
      fixture.calls.push({ method, path });
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      const organization = path.split('/')[2];
      const workItem = () => ({ id: 42, rev: fixture.ado.revision, fields: { 'System.Title': fixture.ado.title, 'System.Description': fixture.ado.description, 'System.TeamProject': 'Docs', 'System.WorkItemType': 'Task', 'System.State': 'Active' }, relations: fixture.ado.attachment ? [{ rel: 'AttachedFile', url: `https://dev.azure.com/${organization}/Docs/_apis/wit/attachments/shared-review`, attributes: { name: 'docthread-review.json', comment: 'docthread-review' } }] : [] });
      if (/\/workitems\/42\/comments(?:\/\d+)?$/i.test(path)) {
        if (method === 'GET') {
          if (fixture.mode === 'ado-read-failed') return json({ message: 'Simulated discussion read failure' }, 500);
          return json({ comments: fixture.ado.discussionText ? [{ id: 7, text: fixture.ado.discussionText }] : [] });
        }
        if (['POST', 'PATCH'].includes(method)) {
          if (fixture.mode === 'ado-save-failed') return json({ message: 'Simulated discussion save failure' }, 403);
          const marker = /docthread-review:v1\s+([A-Za-z0-9+/=]+)/.exec(body?.text || '');
          if (!marker) throw new Error('Missing discussion snapshot in fixture write');
          fixture.ado.discussion = JSON.parse(decodeURIComponent(escape(atob(marker[1]))));
          fixture.ado.discussionText = body.text;
          fixture.persistAdo();
          return json({ id: 7, text: body.text });
        }
      }
      if (/\/attachments\/shared-review$/i.test(path) && method === 'GET') {
        if (fixture.mode === 'ado-read-failed') return json({ message: 'Simulated attachment read failure' }, 500);
        return json(fixture.ado.attachment);
      }
      if (/\/attachments$/i.test(path) && method === 'POST') {
        fixture.adoPending = body;
        return json({ url: `https://dev.azure.com/${organization}/Docs/_apis/wit/attachments/shared-review` });
      }
      if (/\/workitems\/42$/i.test(path)) {
        if (method === 'GET') return json(workItem());
        if (method === 'PATCH' && Array.isArray(body)) {
          if (fixture.mode === 'ado-save-failed') return json({ message: 'Simulated work-item save failure' }, 409);
          for (const operation of body) {
            if (operation.path === '/relations/-') fixture.ado.attachment = fixture.adoPending;
            if (operation.path === '/fields/System.Title') fixture.ado.title = operation.value;
            if (operation.path === '/fields/System.Description') fixture.ado.description = operation.value;
          }
          fixture.ado.revision += 1;
          fixture.persistAdo();
          return json(workItem());
        }
      }
      fixture.unexpected.push({ method, path });
      throw new Error(`Unexpected ADO fixture request: ${method} ${path}`);
    }
    if (path.startsWith('/gh-api')) {
      fixture.calls.push({ method, path });
      const body = options.body ? JSON.parse(String(options.body)) : {};
      if (fixture.mode === 'private-denied') return json({ message: 'Resource not accessible' }, 403);
      if (path === '/gh-api/graphql') {
        const repository = {};
        for (const [key, value] of Object.entries(body.variables || {})) {
          if (!key.startsWith('revision')) continue;
          const index = key.slice('revision'.length);
          const expression = body.variables[`expression${index}`];
          const validRef = value === 'refs/heads/main' || value === 'refs/tags/v1';
          if (validRef && (expression === `${value}:docs/review.md` || expression === `${value}:docs/review.html`)) {
            repository[`probe${index}Revision`] = { target: { __typename: 'Commit', oid: 'a'.repeat(40) } };
            repository[`probe${index}File`] = { __typename: 'Blob', oid: 'd'.repeat(40) };
          }
        }
        return json({ data: { repository } });
      }
      if (path.includes('/git/ref/heads/') && method === 'GET') return json({ object: { sha: revision() } });
      if (path.includes('/contents/')) {
        const filePath = path.split('/contents/')[1];
        if (filePath === 'docs/review.md' || filePath === 'docs/review.html') {
          const htmlFile = filePath.endsWith('.html');
          if (method === 'PUT') {
            if (fixture.mode === 'document-failed') return json({ message: 'Simulated source conflict' }, 409);
            if (htmlFile) fixture.html = decodeURIComponent(escape(atob(body.content)));
            else fixture.markdown = decodeURIComponent(escape(atob(body.content)));
            return json({ content: { sha: 'e'.repeat(40) } });
          }
          return json({ type: 'file', content: encoded(htmlFile ? fixture.html : fixture.markdown), sha: 'd'.repeat(40) });
        }
        if (filePath === '.docthread/v2/docs/review.html.json') {
          return json({ type: 'file', content: encoded(JSON.stringify({
            ...fixture.remote,
            source: { provider: 'github', path: 'docs/review.html' },
            docPath: 'docs/review.html',
          })), sha: 'f'.repeat(40) });
        }
        if (filePath === '.docthread/v2/docs/review.md.json') return json({ type: 'file', content: encoded(JSON.stringify(fixture.remote)), sha: 'f'.repeat(40) });
        if (filePath === 'REVIEW.md' && typeof fixture.policyText === 'string') return json({ type: 'file', content: encoded(fixture.policyText), sha: 'f'.repeat(40) });
        return json({ message: 'Not found' }, 404);
      }
      if (path.endsWith('/git/blobs') && method === 'POST') { fixture.pendingFile = JSON.parse(body.content); return json({ sha: 'b'.repeat(40) }); }
      if (path.includes('/git/commits/') && method === 'GET') return json({ tree: { sha: 'c'.repeat(40) } });
      if (path.endsWith('/git/trees') && method === 'POST') return json({ sha: 'c'.repeat(40) });
      if (path.endsWith('/git/commits') && method === 'POST') return json({ sha: 'b'.repeat(40) });
      if (path.includes('/git/refs/heads/') && method === 'PATCH') {
        if (body.force !== false) throw new Error('Fixture rejects forced ref updates');
        if (fixture.mode === 'conflict') return json({ message: 'Simulated non-fast-forward conflict' }, 422);
        const complete = () => { fixture.remote = fixture.pendingFile; return json({ object: { sha: 'b'.repeat(40) } }); };
        if (fixture.mode === 'hold-save') return new Promise(resolve => { fixture.releaseSave = () => resolve(complete()); });
        return complete();
      }
      fixture.unexpected.push({ method, path });
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }
    if (url.origin !== location.origin || /\/(api|auth|ado-auth|ado-api)\b/.test(path) || !['GET', 'HEAD'].includes(method)) {
      fixture.unexpected.push({ method, path });
      throw new Error('External/provider access disabled in UI tests');
    }
    return nativeFetch(input, options);
  };
})();
