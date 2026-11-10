import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { buildTeamsMessage, sendTeamsNotification } from '../src/notifyTeams.ts';

test('buildTeamsMessage produces a MessageCard with title, body, and open action', () => {
  const card = buildTeamsMessage({
    actor: 'Bob',
    docLabel: 'spec.md',
    docUrl: 'https://app.example/?thread=t1',
    commentBody: 'Please review @maya',
    intent: 'Blocking',
    recipients: ['Maya'],
  }) as any;
  assert.equal(card['@type'], 'MessageCard');
  assert.match(card.title, /Bob mentioned you/);
  assert.equal(card.sections[0].text, 'Please review @maya');
  assert.deepEqual(card.sections[0].facts, [
    { name: 'Intent', value: 'Blocking' },
    { name: 'For', value: 'Maya' },
  ]);
  assert.equal(card.potentialAction[0].targets[0].uri, 'https://app.example/?thread=t1');
});

test('buildTeamsMessage omits the action when no docUrl is given', () => {
  const card = buildTeamsMessage({ actor: 'Bob', docLabel: 'x', commentBody: 'hi' }) as any;
  assert.equal(card.potentialAction, undefined);
  assert.equal(card.sections[0].facts, undefined);
});

test('sendTeamsNotification posts { to, teams } and reports the relay result', async () => {
  let captured: any;
  const fakeFetch = (async (_url: string, init: any) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ delivered: true, status: 200 }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await sendTeamsNotification(
    '/api/notify',
    { to: ['maya@microsoft.com'], card: { '@type': 'MessageCard' } },
    fakeFetch
  );
  assert.equal(result.delivered, true);
  assert.deepEqual(captured.to, ['maya@microsoft.com']);
  assert.deepEqual(captured.teams, { '@type': 'MessageCard' });
});

test('sendTeamsNotification returns undelivered with no recipients (no call made)', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const result = await sendTeamsNotification('/api/notify', { to: [], card: {} }, fakeFetch);
  assert.equal(result.delivered, false);
  assert.equal(called, false);
});

// The relay's Teams branch must enforce the same recipient allowlist and only
// forward to TEAMS_WEBHOOK_URL — never an open relay.
test('notify relay Teams branch enforces the allowlist and targets TEAMS_WEBHOOK_URL', async () => {
  const require = createRequire(import.meta.url);
  const notify = require('../api/notify/index.js');

  const context = () => {
    const ctx: any = {};
    return ctx;
  };
  const originalFetch = globalThis.fetch;
  const prevTeams = process.env.TEAMS_WEBHOOK_URL;
  const prevDomains = process.env.NOTIFY_ALLOWED_DOMAINS;
  let forwardedUrl: string | undefined;
  let forwardedBody: any;
  globalThis.fetch = (async (url: string, init: any) => {
    forwardedUrl = String(url);
    forwardedBody = JSON.parse(String(init.body));
    return new Response('OK', { status: 200 });
  }) as unknown as typeof fetch;
  process.env.TEAMS_WEBHOOK_URL = 'https://teams.example/webhook';
  process.env.NOTIFY_ALLOWED_DOMAINS = 'microsoft.com';

  try {
    // All-external recipients: nothing is forwarded to Teams.
    const ctxA = context();
    await notify(ctxA, { body: { to: ['attacker@evil.com'], teams: { '@type': 'MessageCard' } } });
    assert.equal(forwardedUrl, undefined);
    assert.match(JSON.parse(ctxA.res.body).reason, /allowed domains/);

    // Allowed recipient: the card is forwarded to the Teams webhook.
    const ctxB = context();
    await notify(ctxB, {
      body: { to: ['maya@microsoft.com'], teams: { '@type': 'MessageCard', title: 'hi' } },
    });
    assert.equal(forwardedUrl, 'https://teams.example/webhook');
    assert.equal(forwardedBody.title, 'hi');
    assert.equal(JSON.parse(ctxB.res.body).delivered, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevTeams === undefined) delete process.env.TEAMS_WEBHOOK_URL;
    else process.env.TEAMS_WEBHOOK_URL = prevTeams;
    if (prevDomains === undefined) delete process.env.NOTIFY_ALLOWED_DOMAINS;
    else process.env.NOTIFY_ALLOWED_DOMAINS = prevDomains;
  }
});

test('notify relay Teams branch reports when TEAMS_WEBHOOK_URL is unset', async () => {
  const require = createRequire(import.meta.url);
  const notify = require('../api/notify/index.js');
  const prevTeams = process.env.TEAMS_WEBHOOK_URL;
  delete process.env.TEAMS_WEBHOOK_URL;
  try {
    const ctx: any = {};
    await notify(ctx, { body: { to: ['maya@microsoft.com'], teams: { '@type': 'MessageCard' } } });
    const body = JSON.parse(ctx.res.body);
    assert.equal(body.delivered, false);
    assert.match(body.reason, /TEAMS_WEBHOOK_URL/);
  } finally {
    if (prevTeams === undefined) delete process.env.TEAMS_WEBHOOK_URL;
    else process.env.TEAMS_WEBHOOK_URL = prevTeams;
  }
});
