import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REACTION_EMOJIS,
  isReactionEmoji,
  adoReactionIdentityKey,
  compactReactions,
  mergeReactionLists,
  effectiveReactions,
  viewerHasReacted,
  tallyReactions,
  toggleReaction,
} from '../src/reactions.ts';
import { decodeDocThreadFile } from '../src/reviewSchema.ts';
import { mergeDocThreadFiles, ReviewMergeError } from '../src/reviewPersistence.ts';
import type { DocThreadFileV2, Reaction } from '../src/types.ts';

const T0 = '2026-08-23T10:00:00.000Z';
const T1 = '2026-08-23T10:01:00.000Z';
const T2 = '2026-08-23T10:02:00.000Z';
const T3 = '2026-08-23T10:03:00.000Z';

const ALICE = 'github:U_alice';
const BOB = 'github:U_bob';

// ---------------------------------------------------------------------------
// Pure helpers (src/reactions.ts)
// ---------------------------------------------------------------------------

test('isReactionEmoji accepts the allow-list and rejects everything else', () => {
  for (const emoji of REACTION_EMOJIS) assert.equal(isReactionEmoji(emoji), true);
  assert.equal(isReactionEmoji('🙈'), false);
  assert.equal(isReactionEmoji('x'), false);
  assert.equal(isReactionEmoji(''), false);
});

test('adoReactionIdentityKey builds a schema-valid key and sanitizes segments', () => {
  assert.equal(adoReactionIdentityKey('contoso', 'mayast'), 'azure-devops:contoso:mayast');
  // '@' and whitespace are replaced so the key matches the identity-key grammar.
  assert.equal(
    adoReactionIdentityKey('contoso', 'maya@contoso.com'),
    'azure-devops:contoso:maya_contoso.com'
  );
  assert.equal(adoReactionIdentityKey('big org', 'a b'), 'azure-devops:big_org:a_b');
  assert.equal(adoReactionIdentityKey(undefined, 'x'), null);
  assert.equal(adoReactionIdentityKey('org', undefined), null);
});

test('toggleReaction adds then removes for the same reactor', () => {
  const added = toggleReaction(undefined, '👍', ALICE, 'Alice', T0);
  assert.equal(effectiveReactions(added).length, 1);
  assert.equal(added[0].emoji, '👍');
  assert.equal(added[0].by, ALICE);
  assert.equal(added[0].byName, 'Alice');

  const removed = toggleReaction(added, '👍', ALICE, 'Alice', T1);
  assert.equal(effectiveReactions(removed).length, 0);
  // The tombstone is retained so a concurrent copy of the add can't resurrect it.
  assert.equal(removed.length, 1);
  assert.equal(removed[0].removed, true);
});

test('toggleReaction keeps distinct reactors and emojis independent', () => {
  let reactions = toggleReaction(undefined, '👍', ALICE, 'Alice', T0);
  reactions = toggleReaction(reactions, '👍', BOB, 'Bob', T1);
  reactions = toggleReaction(reactions, '✅', ALICE, 'Alice', T2);
  const live = effectiveReactions(reactions);
  assert.equal(live.length, 3);
  const thumbs = tallyReactions(reactions).find((t) => t.emoji === '👍');
  assert.equal(thumbs?.count, 2);
});

test('tallyReactions aggregates counts, viewer state, and names in allow-list order', () => {
  let reactions = toggleReaction(undefined, '✅', BOB, 'Bob', T0);
  reactions = toggleReaction(reactions, '👍', ALICE, 'Alice', T1);
  reactions = toggleReaction(reactions, '👍', BOB, 'Bob', T2);
  const tallies = tallyReactions(reactions, [ALICE]);
  // 👍 comes before ✅ in REACTION_EMOJIS.
  assert.deepEqual(tallies.map((t) => t.emoji), ['👍', '✅']);
  const thumbs = tallies[0];
  assert.equal(thumbs.count, 2);
  assert.equal(thumbs.reactedByViewer, true);
  assert.deepEqual([...thumbs.names].sort(), ['Alice', 'Bob']);
  assert.equal(tallies[1].reactedByViewer, false);
});

test('viewerHasReacted matches any of the viewer identity keys', () => {
  const reactions = toggleReaction(undefined, '👀', ALICE, 'Alice', T0);
  assert.equal(viewerHasReacted(reactions, '👀', [ALICE]), true);
  assert.equal(viewerHasReacted(reactions, '👀', ['github:U_other', ALICE]), true);
  assert.equal(viewerHasReacted(reactions, '👀', [BOB]), false);
  assert.equal(viewerHasReacted(reactions, '👍', [ALICE]), false);
});

test('compactReactions collapses duplicate (emoji, reactor) keeping the latest event', () => {
  const events: Reaction[] = [
    { emoji: '👍', by: ALICE, at: T0 },
    { emoji: '👍', by: ALICE, at: T2, removed: true },
    { emoji: '👍', by: ALICE, at: T1 },
  ];
  const compacted = compactReactions(events);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].at, T2);
  assert.equal(compacted[0].removed, true);
});

// ---------------------------------------------------------------------------
// CRDT-style merge (src/reactions.ts + persistence)
// ---------------------------------------------------------------------------

test('mergeReactionLists keeps concurrent reactions from different reactors', () => {
  const local: Reaction[] = [{ emoji: '👍', by: ALICE, at: T0, byName: 'Alice' }];
  const remote: Reaction[] = [{ emoji: '👍', by: BOB, at: T1, byName: 'Bob' }];
  const merged = mergeReactionLists(local, remote)!;
  assert.equal(effectiveReactions(merged).length, 2);
});

test('mergeReactionLists does not resurrect a reaction removed later', () => {
  // Remote still has Alice's add at T0; local removed it at T1.
  const remote: Reaction[] = [{ emoji: '👍', by: ALICE, at: T0 }];
  const local: Reaction[] = [
    { emoji: '👍', by: ALICE, at: T0 },
    { emoji: '👍', by: ALICE, at: T1, removed: true },
  ];
  const merged = mergeReactionLists(local, remote)!;
  assert.equal(effectiveReactions(merged).length, 0);
});

test('mergeReactionLists returns undefined when both sides are empty', () => {
  assert.equal(mergeReactionLists(undefined, undefined), undefined);
  assert.equal(mergeReactionLists([], undefined), undefined);
});

// ---------------------------------------------------------------------------
// Strict schema decode (src/reviewSchema.ts)
// ---------------------------------------------------------------------------

function v2FileWith(reactions: unknown): unknown {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: 'docs/review.md' },
    docPath: 'docs/review.md',
    updatedAt: T0,
    threads: [
      {
        id: 'thread-1',
        anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
        resolved: false,
        intent: 'question',
        createdAt: T0,
        clocks: { resolutionAt: T0, intentAt: T0, anchorAt: T0 },
        comments: [
          {
            id: 'comment-1',
            author: 'Maya Stewart',
            authorIdentityKeys: ['github:U_maya'],
            identityVersion: 1,
            body: 'Looks good',
            createdAt: T0,
            mentions: [],
            ...(reactions === undefined ? {} : { reactions }),
          },
        ],
      },
    ],
  };
}

test('decode accepts valid reactions and preserves the emoji', () => {
  const decoded = decodeDocThreadFile(
    v2FileWith([
      { emoji: '👍', by: ALICE, at: T0, byName: 'Alice' },
      { emoji: '✅', by: BOB, at: T1 },
    ]),
    { remote: true }
  );
  const reactions = decoded.threads[0].comments[0].reactions!;
  assert.equal(reactions.length, 2);
  assert.equal(reactions.some((r) => r.emoji === '👍'), true);
  assert.equal(reactions.some((r) => r.emoji === '✅'), true);
});

test('decode is back-compatible with comments that have no reactions', () => {
  const decoded = decodeDocThreadFile(v2FileWith(undefined), { remote: true });
  assert.equal(decoded.threads[0].comments[0].reactions, undefined);
});

test('decode rejects an unsupported reaction emoji', () => {
  assert.throws(
    () => decodeDocThreadFile(v2FileWith([{ emoji: '🙈', by: ALICE, at: T0 }]), { remote: true }),
    /unsupported reaction emoji/
  );
});

test('decode rejects a reactor that is not a valid identity key', () => {
  assert.throws(
    () => decodeDocThreadFile(v2FileWith([{ emoji: '👍', by: 'alice', at: T0 }]), { remote: true }),
    /identity key/
  );
});

test('decode rejects a duplicate (emoji, reactor) pair', () => {
  assert.throws(
    () =>
      decodeDocThreadFile(
        v2FileWith([
          { emoji: '👍', by: ALICE, at: T0 },
          { emoji: '👍', by: ALICE, at: T1 },
        ]),
        { remote: true }
      ),
    /duplicate reaction/
  );
});

test('decode rejects removed set to anything other than true', () => {
  assert.throws(
    () =>
      decodeDocThreadFile(v2FileWith([{ emoji: '👍', by: ALICE, at: T0, removed: false }]), {
        remote: true,
      }),
    /must be true/
  );
});

test('decode rejects an unknown field on a reaction', () => {
  assert.throws(
    () =>
      decodeDocThreadFile(v2FileWith([{ emoji: '👍', by: ALICE, at: T0, weight: 5 }]), {
        remote: true,
      }),
    /unknown field/
  );
});

// ---------------------------------------------------------------------------
// Persistence merge with reactions (src/reviewPersistence.ts)
// ---------------------------------------------------------------------------

function fileWithReactions(reactions: Reaction[], overrides: Record<string, unknown> = {}): DocThreadFileV2 {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: 'docs/review.md' },
    docPath: 'docs/review.md',
    updatedAt: T3,
    threads: [
      {
        id: 'thread-1',
        anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
        resolved: false,
        intent: 'question',
        createdAt: T0,
        clocks: { resolutionAt: T0, intentAt: T0, anchorAt: T0 },
        comments: [
          {
            id: 'comment-1',
            author: 'Maya',
            authorIdentityKeys: ['github:U_maya'],
            identityVersion: 1,
            body: 'Looks good',
            createdAt: T0,
            mentions: [],
            reactions,
          },
        ],
        ...overrides,
      },
    ],
  };
}

test('merge unions concurrent reactions on the same comment', () => {
  const local = fileWithReactions([{ emoji: '👍', by: ALICE, at: T0 }]);
  const remote = fileWithReactions([{ emoji: '👍', by: BOB, at: T1 }]);
  const merged = mergeDocThreadFiles(local, remote);
  const reactions = merged.threads[0].comments[0].reactions!;
  assert.equal(effectiveReactions(reactions).length, 2);
});

test('merge rejects a new reaction added after a remote deletion tombstone', () => {
  const remote = fileWithReactions([], { deletedAt: T1 });
  const local = fileWithReactions([{ emoji: '👍', by: ALICE, at: T2 }]);
  assert.throws(() => mergeDocThreadFiles(local, remote), ReviewMergeError);
});

// ---------------------------------------------------------------------------
// Emoji survives the storage round-trip (GitHub + Azure DevOps)
// ---------------------------------------------------------------------------

test('reactions with emoji survive a JSON serialize/parse + strict decode', () => {
  const file = fileWithReactions([
    { emoji: '👍', by: ALICE, at: T0 },
    { emoji: '👀', by: BOB, at: T1 },
    { emoji: '❤️', by: 'github:U_cara', at: T2 },
  ]);
  // Every transport serializes the file with JSON.stringify and re-decodes it.
  const roundTripped = decodeDocThreadFile(JSON.parse(JSON.stringify(file)), { remote: true });
  const reactions = roundTripped.threads[0].comments[0].reactions!;
  assert.deepEqual(
    reactions.map((r) => r.emoji).sort(),
    ['❤️', '👀', '👍'].sort()
  );
});

test('emoji survive the UTF-8 base64 wrappers used by GitHub and Azure DevOps storage', () => {
  const json = JSON.stringify(
    fileWithReactions([{ emoji: '👍', by: ALICE, at: T0, byName: 'Alice 🎉' }])
  );

  // Mirror of src/github.ts toB64/fromB64 (contents API / hidden payloads).
  const ghB64 = btoa(unescape(encodeURIComponent(json)));
  const ghDecoded = decodeURIComponent(escape(atob(ghB64)));
  assert.equal(ghDecoded, json);

  // Mirror of src/ado.ts encodeReview/decodeReview (work-item hidden payload).
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const adoB64 = btoa(binary);
  const adoDecoded = new TextDecoder().decode(
    Uint8Array.from(atob(adoB64), (ch) => ch.charCodeAt(0))
  );
  assert.equal(adoDecoded, json);

  // Both wrappers preserve the multi-byte reaction + name emoji through decode.
  assert.equal(JSON.parse(ghDecoded).threads[0].comments[0].reactions[0].emoji, '👍');
  assert.equal(JSON.parse(adoDecoded).threads[0].comments[0].reactions[0].byName, 'Alice 🎉');
});
