import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import worker from '../worker/index.js';

const require = createRequire(import.meta.url);
const deviceCode = require('../api/device-code/index.js');
const oauthToken = require('../api/oauth-token/index.js');

function context() {
  return { log: { error() {} } };
}

test('device-code relay forwards only the public OAuth fields to GitHub', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ device_code: 'device', user_code: 'ABCD' });
  };
  try {
    const response = await deviceCode(context(), {
      body: { client_id: 'client', scope: 'repo', ignored: 'secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(request.url, 'https://github.com/login/device/code');
    assert.equal(String(request.init.body), 'client_id=client&scope=repo+read%3Aorg');
    assert.equal(response.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('token relay validates required fields and forwards the device grant', async () => {
  assert.equal((await oauthToken(context(), { body: {} })).status, 400);

  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ access_token: 'token' });
  };
  try {
    const response = await oauthToken(context(), {
      body: { client_id: 'client', device_code: 'device' },
    });
    assert.equal(response.status, 200);
    assert.equal(request.url, 'https://github.com/login/oauth/access_token');
    const form = new URLSearchParams(String(request.init.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('privileged relay routes are absent from the API and Worker', () => {
  // gh-api and ado-api inject server-side credentials and must never be deployed
  // as relays. The notify route is allowed to exist (mention emails need it) but
  // must NOT be an open relay — see the dedicated notify test below.
  for (const route of ['ado-api', 'gh-api']) {
    assert.equal(fs.existsSync(new URL(`../api/${route}/function.json`, import.meta.url)), false);
    assert.equal(fs.existsSync(new URL(`../api/${route}/index.js`, import.meta.url)), false);
  }
  const worker = fs.readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /\/notify/);
  assert.match(worker, /scope: 'repo read:org'/);
});

test('notify relay enforces a recipient domain allowlist (no open relay)', () => {
  // The notify Azure function may exist, but it must filter recipients against a
  // domain allowlist before forwarding to the Outlook webhook, so it can never be
  // abused to email arbitrary external addresses.
  const src = fs.readFileSync(new URL('../api/notify/index.js', import.meta.url), 'utf8');
  assert.match(src, /NOTIFY_ALLOWED_DOMAINS/);
  assert.match(src, /filterAllowedRecipients/);

  // Load the function and prove disallowed recipients are dropped without ever
  // reaching the webhook.
  const notify = require('../api/notify/index.js');
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;
  const originalDomains = process.env.NOTIFY_ALLOWED_DOMAINS;
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = JSON.parse(String(init.body));
    return new Response('OK', { status: 202 });
  };
  process.env.NOTIFY_WEBHOOK_URL = 'https://logic.example/notify';
  process.env.NOTIFY_ALLOWED_DOMAINS = 'microsoft.com';
  return (async () => {
    try {
      // All-external recipients: nothing is forwarded.
      const ctxA = context();
      await notify(ctxA, { body: { to: ['attacker@evil.com'], subject: 's', html: 'h' } });
      assert.equal(forwarded, undefined);
      assert.match(JSON.parse(ctxA.res.body).reason, /allowed domains/);

      // Mixed recipients: only allowed-domain addresses are forwarded.
      const ctxB = context();
      await notify(ctxB, {
        body: { to: ['maya@microsoft.com', 'attacker@evil.com'], subject: 's', html: 'h' },
      });
      assert.deepEqual(forwarded.to, ['maya@microsoft.com']);
      assert.equal(JSON.parse(ctxB.res.body).delivered, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
      else process.env.NOTIFY_WEBHOOK_URL = originalEnv;
      if (originalDomains === undefined) delete process.env.NOTIFY_ALLOWED_DOMAINS;
      else process.env.NOTIFY_ALLOWED_DOMAINS = originalDomains;
    }
  })();
});

test('optional Worker rejects unapproved origins and marks OAuth responses no-store', async () => {
  const denied = await worker.fetch(
    new Request('https://worker.example/device/code', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'client' }),
    }),
    { ALLOWED_ORIGINS: 'https://docthread.example' }
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(denied.headers.get('Cache-Control'), 'no-store');

  const invalid = await worker.fetch(
    new Request('https://worker.example/device/code', {
      method: 'POST',
      headers: { Origin: 'https://docthread.example', 'Content-Type': 'application/json' },
      body: '{}',
    }),
    { ALLOWED_ORIGINS: 'https://docthread.example' }
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('Access-Control-Allow-Origin'), 'https://docthread.example');
  assert.equal(invalid.headers.get('Cache-Control'), 'no-store');
});