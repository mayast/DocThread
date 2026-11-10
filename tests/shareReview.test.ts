import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseInviteEmails,
  partitionInviteEmails,
  makeInvite,
  mergeInvites,
  deriveParticipation,
  buildShareInviteEmail,
  parseInvites,
  invitesStorageKey,
  loadInvites,
  storeInvites,
  type Invite,
} from '../src/shareReview.ts';
import type { Thread } from '../src/types.ts';

const DOMAINS = ['microsoft.com'];

function thread(id: string, comments: { author: string; authorLogin?: string }[], extra: Partial<Thread> = {}): Thread {
  return {
    id,
    anchor: { quote: 'q', prefix: '', suffix: '', start: 0 },
    resolved: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    comments: comments.map((c, i) => ({
      id: `${id}-c${i}`,
      author: c.author,
      authorLogin: c.authorLogin,
      body: 'hi',
      createdAt: '2026-09-01T00:00:00.000Z',
    })),
    ...extra,
  } as Thread;
}

test('parseInviteEmails splits on commas/semicolons/whitespace and de-dupes case-insensitively', () => {
  const parsed = parseInviteEmails('a@microsoft.com, B@microsoft.com;a@MICROSOFT.com\n c@microsoft.com');
  assert.deepEqual(parsed, ['a@microsoft.com', 'B@microsoft.com', 'c@microsoft.com']);
  assert.deepEqual(parseInviteEmails(''), []);
  assert.deepEqual(parseInviteEmails('   '), []);
});

test('partitionInviteEmails contacts only allow-listed addresses; externals are rejected', () => {
  const { allowed, rejected } = partitionInviteEmails(
    ['alex@microsoft.com', 'evil@attacker.com', 'not-an-email', 'sub@team.microsoft.com'],
    DOMAINS
  );
  assert.deepEqual(allowed, ['alex@microsoft.com', 'sub@team.microsoft.com']);
  // External + malformed addresses must never be contacted.
  assert.deepEqual(rejected, ['evil@attacker.com', 'not-an-email']);
});

test('makeInvite lowercases email and trims optional fields', () => {
  const inv = makeInvite('  Alex@Microsoft.com ', '2026-09-01T00:00:00.000Z', '  please review  ', '  Alex  ');
  assert.equal(inv.email, 'alex@microsoft.com');
  assert.equal(inv.message, 'please review');
  assert.equal(inv.displayName, 'Alex');
  const bare = makeInvite('x@microsoft.com', '2026-09-01T00:00:00.000Z', '   ', '');
  assert.equal(bare.message, undefined);
  assert.equal(bare.displayName, undefined);
});

test('mergeInvites de-dupes by email (newest wins) without mutating inputs', () => {
  const existing: Invite[] = [makeInvite('a@microsoft.com', 't1')];
  const added: Invite[] = [
    makeInvite('A@microsoft.com', 't2', 'again'), // same address, mixed case
    makeInvite('b@microsoft.com', 't3'),
  ];
  const merged = mergeInvites(existing, added);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((i) => i.email === 'a@microsoft.com')?.invitedAt, 't2');
  assert.equal(merged.find((i) => i.email === 'a@microsoft.com')?.message, 'again');
  assert.equal(existing.length, 1); // input untouched
});

test('deriveParticipation marks reviewed by display name, login, or email local-part', () => {
  const invites: Invite[] = [
    { email: 'alex@microsoft.com', invitedAt: 't', displayName: 'Alex Kim' },
    { email: 'jordan@microsoft.com', invitedAt: 't' },
    { email: 'sam@microsoft.com', invitedAt: 't' },
    { email: 'pat@microsoft.com', invitedAt: 't' },
  ];
  const threads: Thread[] = [
    thread('t1', [{ author: 'Alex Kim' }]), // matches displayName
    thread('t2', [{ author: 'Someone', authorLogin: 'jordan' }]), // matches login = local-part
    thread('t3', [{ author: 'sam' }]), // matches author == local-part
  ];
  const p = deriveParticipation(invites, threads);
  assert.equal(p.find((x) => x.email === 'alex@microsoft.com')?.status, 'reviewed');
  assert.equal(p.find((x) => x.email === 'jordan@microsoft.com')?.status, 'reviewed');
  assert.equal(p.find((x) => x.email === 'sam@microsoft.com')?.status, 'reviewed');
  assert.equal(p.find((x) => x.email === 'pat@microsoft.com')?.status, 'invited');
});

test('deriveParticipation ignores comments in deleted threads', () => {
  const invites: Invite[] = [{ email: 'alex@microsoft.com', invitedAt: 't', displayName: 'Alex' }];
  const threads: Thread[] = [thread('t1', [{ author: 'Alex' }], { deletedAt: '2026-09-01T01:00:00.000Z' })];
  assert.equal(deriveParticipation(invites, threads)[0].status, 'invited');
});

test('buildShareInviteEmail embeds the exact link and message, and escapes HTML', () => {
  const { subject, html } = buildShareInviteEmail({
    actor: 'Maya <PM>',
    docLabel: 'API & Design',
    docUrl: 'https://app.example/?target=abc&x=1',
    message: 'Look at <section> 2',
  });
  assert.match(subject, /invited you to review/);
  assert.ok(html.includes('https://app.example/?target=abc&amp;x=1'));
  assert.ok(html.includes('Maya &lt;PM&gt;'));
  assert.ok(html.includes('API &amp; Design'));
  assert.ok(html.includes('Look at &lt;section&gt; 2'));
});

test('buildShareInviteEmail omits the message block when none is given', () => {
  const { html } = buildShareInviteEmail({ actor: 'A', docLabel: 'D', docUrl: 'https://x/' });
  assert.ok(!html.includes('blockquote'));
});

test('parseInvites validates records and drops malformed/duplicate entries', () => {
  const raw = JSON.stringify([
    { email: 'a@microsoft.com', invitedAt: 't1', message: 'm' },
    { email: 'a@microsoft.com', invitedAt: 't2' }, // dup
    { email: '', invitedAt: 't' }, // no email
    { invitedAt: 't' }, // missing email
    { email: 'b@microsoft.com' }, // missing invitedAt
    'nope',
  ]);
  const parsed = parseInvites(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].email, 'a@microsoft.com');
  assert.equal(parsed[0].message, 'm');
  assert.deepEqual(parseInvites('not json'), []);
  assert.deepEqual(parseInvites(null), []);
});

test('loadInvites/storeInvites round-trip through a localStorage stub, keyed by source', () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    const key = 'github:owner/repo:main:doc.md';
    assert.deepEqual(loadInvites(key), []);
    const invites: Invite[] = [makeInvite('a@microsoft.com', 't1', 'hi', 'A')];
    storeInvites(key, invites);
    assert.ok(store.has(invitesStorageKey(key)));
    const loaded = loadInvites(key);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].email, 'a@microsoft.com');
    // A different document's key is isolated.
    assert.deepEqual(loadInvites('github:other/repo:main:doc.md'), []);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
