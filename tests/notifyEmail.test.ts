import assert from 'node:assert/strict';
import test from 'node:test';

import { rememberMentionContact, mentionContact } from '../src/mentionContacts.ts';
import {
  sendMentionEmail,
  buildMentionEmail,
  collectMentionEmailTargets,
} from '../src/notifyEmail.ts';
import type { MentionReference } from '../src/types.ts';

function resolvedMention(subjectKey: string, handle: string): MentionReference {
  const text = `@${handle}`;
  return {
    kind: 'resolved',
    start: 0,
    length: text.length,
    text,
    subjectKey,
    identityKeys: [subjectKey],
    authority: 'entra',
    displayName: handle,
    handle,
    route: { kind: 'none' },
  };
}

test('collectMentionEmailTargets returns deduped contacts for resolved mentions only', () => {
  const contacts: Record<string, { email: string; displayName: string }> = {
    'entra:t:1': { email: 'alice@microsoft.com', displayName: 'Alice' },
    'entra:t:2': { email: 'alice@microsoft.com', displayName: 'Alice Alt' },
    'entra:t:3': { email: 'bob@microsoft.com', displayName: 'Bob' },
  };
  const lookup = (key: string) => contacts[key];
  const mentions: MentionReference[] = [
    resolvedMention('entra:t:1', 'alice'),
    resolvedMention('entra:t:2', 'alice2'), // same email -> deduped
    resolvedMention('entra:t:3', 'bob'),
    resolvedMention('entra:t:none', 'carol'), // resolved but no contact -> skipped
    { kind: 'unresolved', start: 0, length: 4, text: '@dan', handle: 'dan' },
  ];
  const out = collectMentionEmailTargets(mentions, lookup);
  assert.deepEqual(
    out.map((c) => c.email).sort(),
    ['alice@microsoft.com', 'bob@microsoft.com']
  );
});

test('collectMentionEmailTargets emails a mention even when persistence downgraded it', () => {
  // The persisted comment carries the downgraded (unresolved) mention, but the
  // original resolved mentions still let us email — a read-only source must not
  // suppress the notification.
  rememberMentionContact('entra:t:9', 'eve@microsoft.com', 'Eve');
  const original: MentionReference[] = [resolvedMention('entra:t:9', 'eve')];
  const out = collectMentionEmailTargets(original, mentionContact);
  assert.deepEqual(out, [{ email: 'eve@microsoft.com', displayName: 'Eve' }]);
});


test('rememberMentionContact stores only valid email addresses', () => {
  rememberMentionContact('entra:t:1', 'alice@contoso.com', 'Alice');
  assert.deepEqual(mentionContact('entra:t:1'), {
    email: 'alice@contoso.com',
    displayName: 'Alice',
  });

  // Handles / logins / blanks are not stored.
  rememberMentionContact('entra:t:2', 'bob', 'Bob');
  rememberMentionContact('entra:t:3', undefined, 'Carol');
  rememberMentionContact('entra:t:4', '', 'Dave');
  assert.equal(mentionContact('entra:t:2'), undefined);
  assert.equal(mentionContact('entra:t:3'), undefined);
  assert.equal(mentionContact('entra:t:4'), undefined);
});

test('sendMentionEmail posts deduped recipients and reports delivery', async () => {
  let captured: { url: string; body: any } | undefined;
  const fakeFetch = (async (url: string, init: any) => {
    captured = { url: String(url), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ delivered: true, status: 202 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const result = await sendMentionEmail(
    '/api/notify',
    {
      to: ['alice@contoso.com', 'alice@contoso.com', ' bob@contoso.com '],
      subject: 'hi',
      html: '<p>hi</p>',
    },
    fakeFetch
  );

  assert.equal(result.delivered, true);
  assert.equal(result.status, 202);
  assert.ok(captured);
  assert.match(captured!.url, /\/api\/notify$|\/notify$/);
  assert.deepEqual(captured!.body.to, ['alice@contoso.com', 'bob@contoso.com']);
});

test('sendMentionEmail short-circuits when there are no recipients', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const result = await sendMentionEmail('/api/notify', { to: [], subject: 's', html: 'h' }, fakeFetch);
  assert.equal(result.delivered, false);
  assert.equal(called, false);
});

test('sendMentionEmail never throws on network failure', async () => {
  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const result = await sendMentionEmail(
    '/api/notify',
    { to: ['a@contoso.com'], subject: 's', html: 'h' },
    fakeFetch
  );
  assert.equal(result.delivered, false);
  assert.match(result.reason || '', /network down/);
});

test('buildMentionEmail escapes content and includes a document link', () => {
  const { subject, html } = buildMentionEmail({
    actor: 'Maya <PM>',
    docLabel: 'PRD & scope',
    docUrl: 'https://dev.azure.com/ceapex/Engineering/_workitems/edit/42',
    commentBody: 'Please review <script>alert(1)</script>',
  });
  assert.match(subject, /Maya/);
  assert.match(subject, /PRD & scope/);
  // Body content is HTML-escaped (no raw script tag).
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Maya &lt;PM&gt;/);
  assert.match(html, /https:\/\/dev\.azure\.com/);
});
