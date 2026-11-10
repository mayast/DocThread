import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInbox,
  isUnread,
  unreadCount,
  markItemRead,
  markAllRead,
  emptyReadState,
  parseReadState,
  type InboxViewer,
} from '../src/inbox.ts';
import type { Comment, MentionReference, Thread } from '../src/types.ts';

const T1 = '2026-08-24T10:00:00.000Z';
const T2 = '2026-08-24T10:05:00.000Z';
const T3 = '2026-08-24T10:10:00.000Z';

const ME = 'github:ME';
const BOB = 'github:BOB';
const VIEWER: InboxViewer = { identityKeys: [ME], names: ['me'] };

function mentionOf(key: string, handle: string): MentionReference {
  return {
    kind: 'resolved',
    start: 0,
    length: handle.length + 1,
    text: `@${handle}`,
    subjectKey: key,
    identityKeys: [key],
    authority: 'github',
    displayName: handle,
    handle,
    route: { kind: 'github', nodeId: key.replace('github:', '') },
  };
}

function comment(
  id: string,
  author: string,
  key: string | null,
  createdAt: string,
  extra: Partial<Comment> = {}
): Comment {
  return {
    id,
    author,
    authorLogin: author.toLowerCase(),
    authorIdentityKeys: key ? [key] : [],
    identityVersion: 1,
    body: extra.body ?? `Body of ${id}`,
    createdAt,
    mentions: extra.mentions ?? [],
    ...(extra.reactions ? { reactions: extra.reactions } : {}),
  };
}

function thread(id: string, comments: Comment[], extra: Partial<Thread> = {}): Thread {
  return {
    id,
    anchor: { quote: 'q', prefix: '', suffix: '', start: 0 },
    comments,
    resolved: false,
    intent: 'question',
    createdAt: comments[0]?.createdAt ?? T1,
    ...extra,
  };
}

test('a mention I already replied to surfaces as a mention', () => {
  const t = thread('t1', [
    comment('c1', 'Bob', BOB, T1, { mentions: [mentionOf(ME, 'me')], body: 'Hey @me look' }),
    comment('c2', 'Me', ME, T2, { body: 'On it' }),
  ]);
  const items = buildInbox([t], VIEWER);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'mention');
  assert.equal(items[0].commentId, 'c1');
  assert.equal(items[0].actor, 'Bob');
});

test('an unanswered mention surfaces as an assignment (still waiting on me)', () => {
  const t = thread('t2', [
    comment('c1', 'Bob', BOB, T1, { mentions: [mentionOf(ME, 'me')], body: 'Please review @me' }),
  ]);
  const items = buildInbox([t], VIEWER);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assignment');
  assert.equal(items[0].commentId, 'c1');
});

test('a reply on my thread with no mention surfaces as a reply', () => {
  const t = thread('t3', [
    comment('c1', 'Me', ME, T1, { body: 'My question' }),
    comment('c2', 'Bob', BOB, T2, { body: 'An answer' }),
  ]);
  const items = buildInbox([t], VIEWER);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'reply');
  assert.equal(items[0].commentId, 'c2');
});

test('my own comments never notify me (no self-notifications)', () => {
  const t = thread('t4', [
    comment('c1', 'Me', ME, T1, { body: 'Only me here' }),
    comment('c2', 'Me', ME, T2, { body: 'Still only me' }),
  ]);
  assert.deepEqual(buildInbox([t], VIEWER), []);
});

test('deleted threads are excluded', () => {
  const t = thread(
    't5',
    [comment('c1', 'Bob', BOB, T1, { mentions: [mentionOf(ME, 'me')] })],
    { deletedAt: T2 }
  );
  assert.deepEqual(buildInbox([t], VIEWER), []);
});

test('a comment by someone else on a thread I never touched does not notify me', () => {
  const t = thread('t6', [
    comment('c1', 'Bob', BOB, T1, { body: 'Bob starts' }),
    comment('c2', 'Cara', 'github:CARA', T2, { body: 'Cara replies' }),
  ]);
  assert.deepEqual(buildInbox([t], VIEWER), []);
});

test('items are sorted newest-first', () => {
  const older = thread('old', [
    comment('a1', 'Me', ME, T1),
    comment('a2', 'Bob', BOB, T1, { body: 'old reply' }),
  ]);
  const newer = thread('new', [
    comment('b1', 'Me', ME, T2),
    comment('b2', 'Bob', BOB, T3, { body: 'new reply' }),
  ]);
  const items = buildInbox([older, newer], VIEWER);
  assert.equal(items.length, 2);
  assert.equal(items[0].commentId, 'b2');
  assert.equal(items[1].commentId, 'a2');
});

test('handle-based viewer match works without identity keys', () => {
  const t = thread('t7', [
    comment('c1', 'Bob', BOB, T1, {
      mentions: [{ kind: 'unresolved', start: 0, length: 3, text: '@me', handle: 'me' }],
      body: 'ping @me',
    }),
  ]);
  const items = buildInbox([t], { identityKeys: [], names: ['me'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assignment'); // unanswered → waiting on me
});

// ---- read/unread state ----

test('isUnread and unreadCount honor the cutoff and read ids', () => {
  const items = buildInbox(
    [thread('t', [comment('c1', 'Me', ME, T1), comment('c2', 'Bob', BOB, T2, { body: 'reply' })])],
    VIEWER
  );
  const fresh = emptyReadState();
  assert.equal(unreadCount(items, fresh), 1);
  assert.equal(isUnread(items[0], fresh), true);

  const afterRead = markItemRead(fresh, items[0].id);
  assert.equal(isUnread(items[0], afterRead), false);
  assert.equal(unreadCount(items, afterRead), 0);
});

test('markAllRead clears everything and advances the cutoff', () => {
  const items = buildInbox(
    [thread('t', [comment('c1', 'Me', ME, T1), comment('c2', 'Bob', BOB, T2, { body: 'reply' })])],
    VIEWER
  );
  const state = markAllRead(items, '2026-08-24T11:00:00.000Z');
  assert.equal(unreadCount(items, state), 0);
  assert.deepEqual(state.readIds, []);
});

test('parseReadState tolerates malformed input', () => {
  assert.deepEqual(parseReadState('not json'), emptyReadState());
  assert.deepEqual(parseReadState(null), emptyReadState());
  const parsed = parseReadState(JSON.stringify({ lastSeenAt: T1, readIds: ['a', 2, 'b'] }));
  assert.equal(parsed.lastSeenAt, T1);
  assert.deepEqual(parsed.readIds, ['a', 'b']);
});
