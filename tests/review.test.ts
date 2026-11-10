import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignThreadCards,
  deriveWaitingOn,
  extractMentions,
  isWaitingOnViewer,
  packFocusedThreadCards,
  searchThreads,
  sortThreads,
  threadMatchesQuery,
} from '../src/review.ts';
import type { Comment, Thread } from '../src/types.ts';

const T0 = '2026-08-23T10:00:00.000Z';
const T1 = '2026-08-23T10:01:00.000Z';

function identityComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'assignment',
    author: 'Alex Reviewer',
    authorLogin: 'alexr_microsoft',
    authorIdentityKeys: ['github:U_alex'],
    identityVersion: 1,
    body: 'Please review @mayast_microsoft',
    createdAt: T0,
    mentions: [
      {
        kind: 'resolved',
        start: 14,
        length: 18,
        text: '@mayast_microsoft',
        subjectKey: 'github:U_maya',
        identityKeys: ['github:U_maya'],
        authority: 'github',
        displayName: 'Maya Stewart',
        handle: 'mayast_microsoft',
        route: { kind: 'github', nodeId: 'U_maya' },
      },
    ],
    ...overrides,
  };
}

function thread(comments: Comment[]): Thread {
  return {
    id: 'thread-1',
    anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
    comments,
    resolved: false,
    createdAt: T0,
  };
}

test('legacy mention parsing ignores email domains and mid-word at signs', () => {
  assert.deepEqual(extractMentions('ping maya@microsoft.com and word@alias'), []);
  assert.deepEqual(extractMentions('ping (@mayast_microsoft), please'), ['mayast_microsoft']);
});

test('identity-aware waiting-on uses stable keys despite friendly author names', () => {
  const assignment = identityComment();
  assert.deepEqual(deriveWaitingOn(thread([assignment])), ['mayast_microsoft']);
  assert.equal(
    isWaitingOnViewer(thread([assignment]), ['Maya Stewart'], ['github:U_maya']),
    true
  );

  const reply: Comment = {
    id: 'reply',
    author: 'Maya Stewart',
    authorLogin: 'renamed_login',
    authorIdentityKeys: ['github:U_maya'],
    identityVersion: 1,
    mentions: [],
    body: 'Reviewed.',
    createdAt: T1,
  };
  assert.deepEqual(deriveWaitingOn(thread([assignment, reply])), []);
});

test('legacy waiting-on compares authorLogin rather than friendly author text', () => {
  const assignment: Comment = {
    id: 'legacy-assignment',
    author: 'Alex Reviewer',
    body: 'Please ask @mayast',
    createdAt: T0,
  };
  const reply: Comment = {
    id: 'legacy-reply',
    author: 'Maya Stewart',
    authorLogin: 'mayast',
    body: 'Done.',
    createdAt: T1,
  };
  assert.deepEqual(deriveWaitingOn(thread([assignment, reply])), []);
});

// ---- Search & sort (#34) ----

function makeThread(
  id: string,
  over: Partial<Thread> = {},
  comments?: Comment[]
): Thread {
  return {
    id,
    anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
    comments: comments ?? [
      { id: `${id}-c1`, author: 'Someone', body: 'a comment', createdAt: T0 },
    ],
    resolved: false,
    createdAt: T0,
    ...over,
  };
}

test('threadMatchesQuery matches body, author, login, mention handle, and quote', () => {
  const t = thread([identityComment()]); // body "Please review @mayast_microsoft"
  assert.equal(threadMatchesQuery(t, 'please review'), true); // body
  assert.equal(threadMatchesQuery(t, 'Alex Reviewer'), true); // author
  assert.equal(threadMatchesQuery(t, 'alexr_microsoft'), true); // login
  assert.equal(threadMatchesQuery(t, 'mayast'), true); // mention handle (partial)
  assert.equal(threadMatchesQuery(t, '@mayast_microsoft'), true); // handle with @
  assert.equal(threadMatchesQuery(t, 'review'), true); // anchor quote
  assert.equal(threadMatchesQuery(t, 'nonexistent'), false);
});

test('empty query matches everything (search is a no-op)', () => {
  const list = [makeThread('a'), makeThread('b')];
  assert.equal(searchThreads(list, '').length, 2);
  assert.equal(searchThreads(list, '   ').length, 2);
  assert.equal(threadMatchesQuery(makeThread('a'), ''), true);
});

test('searchThreads narrows to matching threads', () => {
  const a = makeThread('a', {}, [{ id: 'a1', author: 'Bob', body: 'ship the release', createdAt: T0 }]);
  const b = makeThread('b', {}, [{ id: 'b1', author: 'Cara', body: 'typo here', createdAt: T0 }]);
  assert.deepEqual(searchThreads([a, b], 'typo').map((t) => t.id), ['b']);
  assert.deepEqual(searchThreads([a, b], 'bob').map((t) => t.id), ['a']);
});

test('sortThreads newest/oldest orders by latest comment time', () => {
  const older = makeThread('old', { createdAt: T0 }, [{ id: 'o1', author: 'X', body: 'x', createdAt: T0 }]);
  const newer = makeThread('new', { createdAt: T1 }, [{ id: 'n1', author: 'Y', body: 'y', createdAt: T1 }]);
  assert.deepEqual(sortThreads([older, newer], 'newest').map((t) => t.id), ['new', 'old']);
  assert.deepEqual(sortThreads([older, newer], 'oldest').map((t) => t.id), ['old', 'new']);
});

test('sortThreads blocking puts blocking threads first, then newest', () => {
  const q = makeThread('q', { intent: 'question', createdAt: T1 });
  const block = makeThread('block', { intent: 'blocking', createdAt: T0 });
  assert.deepEqual(sortThreads([q, block], 'blocking').map((t) => t.id), ['block', 'q']);
});

test('sortThreads never mutates its input', () => {
  const list = [makeThread('a', { createdAt: T0 }), makeThread('b', { createdAt: T1 })];
  const before = list.map((t) => t.id);
  sortThreads(list, 'newest');
  assert.deepEqual(list.map((t) => t.id), before);
});

test('document order follows passages, keeps ties stable and puts orphaned threads last', () => {
  const early = makeThread('early', { anchor: { quote: 'early', prefix: '', suffix: '', start: 10 } });
  const same = makeThread('same', { anchor: early.anchor });
  const late = makeThread('late', { anchor: { ...early.anchor, start: 100 } });
  const orphan = makeThread('orphan', { located: false });
  const input = [late, orphan, early, same];
  assert.deepEqual(sortThreads(input, 'document').map(item => item.id), ['early', 'same', 'late', 'orphan']);
  assert.deepEqual(input.map(item => item.id), ['late', 'orphan', 'early', 'same']);
});

test('document order uses relocated positions instead of stale stored offsets', () => {
  const input = [makeThread('first'), makeThread('second'), makeThread('orphan')];
  const positions = new Map([['second', 0], ['first', 1]]);
  assert.deepEqual(sortThreads(input, 'document', positions).map(item => item.id), ['second', 'first', 'orphan']);
});

test('aligned cards respect the toolbar, passage positions and preceding card height', () => {
  assert.deepEqual(alignThreadCards([
    { top: 200, offset: 0, anchorTop: 150 },
    { top: 412, offset: 0, anchorTop: 600 },
    { top: 624, offset: 0, anchorTop: 620 },
  ]), [0, 188, 0]);
});

test('alignment is idempotent and removes excess gaps after a reply expands', () => {
  assert.deepEqual(alignThreadCards([
    { top: 600, offset: 188, anchorTop: 600 },
    { top: 812, offset: 0, anchorTop: 620 },
  ]), [188, 0]);
  assert.deepEqual(alignThreadCards([
    { top: 200, offset: 0, anchorTop: 200 },
    { top: 800, offset: 188, anchorTop: 600 },
  ]), [0, 0]);
});

test('stacked layouts and unlocated passages reset alignment without changing input', () => {
  const cards = [{ top: 300, offset: 100 }, { top: 600, offset: 80 }];
  assert.deepEqual(alignThreadCards(cards), [0, 0]);
  assert.deepEqual(cards, [{ top: 300, offset: 100 }, { top: 600, offset: 80 }]);
});

test('crowded cards keep their order and the selected card uses the closest available row', () => {
  const cards = [
    { id: 'first', top: 40, height: 220 },
    { id: 'second', top: 60, height: 220 },
    { id: 'selected', top: 80, height: 260 },
    { id: 'later', top: 100, height: 180 },
  ];
  assert.deepEqual(packFocusedThreadCards(cards, 'selected'), [
    { id: 'first', top: 0, height: 220 },
    { id: 'second', top: 232, height: 220 },
    { id: 'selected', top: 464, height: 260 },
    { id: 'later', top: 736, height: 180 },
  ]);
  assert.equal(cards[0].top, 40);
});

test('predecessors use the space above a selected card when they fit', () => {
  assert.deepEqual(packFocusedThreadCards([
    { id: 'first', top: 100, height: 220 },
    { id: 'second', top: 700, height: 220 },
    { id: 'selected', top: 800, height: 260 },
    { id: 'later', top: 1600, height: 180 },
  ], 'selected').map(card => [card.id, card.top]), [
    ['first', 100], ['second', 568], ['selected', 800], ['later', 1600],
  ]);
});

test('a dense shared-passage cluster stays ordered and collision-free for any selected member', () => {
  const cards = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}`, top: 40, height: 140 + index * 15 }));
  const original = structuredClone(cards);
  for (const [selectedIndex, selected] of cards.entries()) {
    const layout = packFocusedThreadCards(cards, selected.id);
    const minimumTop = cards.slice(0, selectedIndex).reduce((top, card) => top + card.height + 12, 0);
    assert.equal(layout[selectedIndex].top, Math.max(40, minimumTop));
    assert.deepEqual(layout.map(card => card.id), cards.map(card => card.id));
    layout.forEach((card, index) => {
      assert.ok(card.top >= 0);
      if (index > 0) assert.ok(card.top >= layout[index - 1].top + layout[index - 1].height + 12);
    });
    assert.deepEqual(packFocusedThreadCards(layout, selected.id), layout);
  }
  assert.deepEqual(cards, original);
  assert.deepEqual(packFocusedThreadCards(cards, 'missing'), []);
});

test('negative passage positions and custom marker gaps cannot reverse the stack', () => {
  const cards = [
    { id: 'first', top: -50, height: 22 },
    { id: 'second', top: -30, height: 22 },
    { id: 'selected', top: -10, height: 22 },
  ];
  assert.deepEqual(packFocusedThreadCards(cards, 'selected', 4).map(card => card.top), [0, 26, 52]);
});
