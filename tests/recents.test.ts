import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRecents,
  promoteRecent,
  serializeRecents,
  RECENTS_LIMIT,
  type RecentEntry,
} from '../src/recents.ts';

function entry(key: string, over: Partial<RecentEntry> = {}): RecentEntry {
  return {
    key,
    url: `https://example/${key}`,
    kind: 'github',
    repoLabel: 'gim-home/DocThread',
    docLabel: `${key}.md`,
    ts: 1,
    ...over,
  };
}

test('promoteRecent moves an existing entry to the front and de-duplicates by key', () => {
  const list = [entry('a'), entry('b'), entry('c')];
  const next = promoteRecent(list, entry('c', { ts: 99 }));
  assert.deepEqual(
    next.map((e) => e.key),
    ['c', 'a', 'b']
  );
  assert.equal(next.filter((e) => e.key === 'c').length, 1);
  assert.equal(next[0].ts, 99);
});

test('promoteRecent prepends a new entry', () => {
  const next = promoteRecent([entry('a'), entry('b')], entry('z'));
  assert.deepEqual(
    next.map((e) => e.key),
    ['z', 'a', 'b']
  );
});

test('promoteRecent caps the list and evicts the oldest', () => {
  let list: RecentEntry[] = [];
  for (let i = 0; i < RECENTS_LIMIT + 5; i++) {
    list = promoteRecent(list, entry(`k${i}`));
  }
  assert.equal(list.length, RECENTS_LIMIT);
  // Most-recent first; the earliest keys have been evicted.
  assert.equal(list[0].key, `k${RECENTS_LIMIT + 4}`);
  assert.ok(!list.some((e) => e.key === 'k0'));
});

test('promoteRecent does not mutate its input', () => {
  const list = [entry('a')];
  const copy = list.slice();
  promoteRecent(list, entry('b'));
  assert.deepEqual(list, copy);
});

test('promoteRecent honors a custom limit and a zero limit', () => {
  assert.equal(promoteRecent([entry('a'), entry('b')], entry('c'), 2).length, 2);
  assert.equal(promoteRecent([entry('a')], entry('b'), 0).length, 0);
});

test('parseRecents round-trips a serialized list', () => {
  const list = [entry('a', { refLabel: 'main' }), entry('b')];
  assert.deepEqual(parseRecents(serializeRecents(list)), list);
});

test('parseRecents returns [] for empty, non-JSON, or non-array input', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents(''), []);
  assert.deepEqual(parseRecents('{not json'), []);
  assert.deepEqual(parseRecents('{"key":"a"}'), []);
});

test('parseRecents drops malformed entries but keeps valid ones', () => {
  const raw = JSON.stringify([
    entry('good', { refLabel: 'main' }),
    { key: 'no-url' },
    { url: 'https://x', repoLabel: 'r', docLabel: 'd', kind: 'github' }, // missing key
    42,
    null,
    entry('good2'),
  ]);
  const parsed = parseRecents(raw);
  assert.deepEqual(
    parsed.map((e) => e.key),
    ['good', 'good2']
  );
  assert.equal(parsed[0].refLabel, 'main');
});

test('parseRecents de-duplicates by key and caps at the limit', () => {
  const many = [];
  for (let i = 0; i < RECENTS_LIMIT + 3; i++) many.push(entry(`k${i}`));
  many.push(entry('k0', { docLabel: 'dupe.md' }));
  const parsed = parseRecents(JSON.stringify(many));
  assert.equal(parsed.length, RECENTS_LIMIT);
  assert.equal(parsed.filter((e) => e.key === 'k0').length, 1);
});

test('parseRecents defaults a missing/invalid ts to 0 and omits blank refLabel', () => {
  const raw = JSON.stringify([
    { key: 'a', url: 'u', kind: 'github', repoLabel: 'r', docLabel: 'd', ts: 'nope', refLabel: '' },
  ]);
  const parsed = parseRecents(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].ts, 0);
  assert.equal('refLabel' in parsed[0], false);
});
