import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalSourceIdentityJson,
  localStorageKeyV2,
  v2SidecarPath,
} from '../src/source.ts';
import { decodeDocThreadFile } from '../src/reviewSchema.ts';

const CREATED = '2026-08-23T10:00:00.000Z';

function v2File() {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: 'docs/review.md' },
    docPath: 'docs/review.md',
    updatedAt: CREATED,
    threads: [
      {
        id: 'thread-1',
        anchor: { quote: 'review', prefix: '', suffix: '', start: 5 },
        resolved: false,
        intent: 'question',
        createdAt: CREATED,
        clocks: { resolutionAt: CREATED, intentAt: CREATED, anchorAt: CREATED },
        comments: [
          {
            id: 'comment-1',
            author: 'Maya Stewart',
            authorLogin: 'mayast',
            authorIdentityKeys: ['entra:tenant-1:object-1'],
            identityVersion: 1,
            body: 'Ask @mayast',
            createdAt: CREATED,
            mentions: [
              {
                kind: 'resolved',
                start: 4,
                length: 7,
                text: '@mayast',
                subjectKey: 'entra:tenant-1:object-1',
                identityKeys: ['entra:tenant-1:object-1'],
                authority: 'entra',
                displayName: 'Maya Stewart',
                handle: 'mayast',
                route: {
                  kind: 'ado-work-item',
                  organization: 'contoso',
                  identityId: 'identity-1',
                  descriptor: 'aad.descriptor-1',
                  originId: 'object-1',
                },
              },
            ],
            dispatch: {
              channel: 'ado-work-item',
              state: 'pending',
              recipientKeys: ['entra:tenant-1:object-1'],
            },
          },
        ],
      },
    ],
  };
}

test('v2 sidecar paths preserve segments, spaces, and Unicode code points', () => {
  assert.equal(v2SidecarPath('a/b.md'), '.docthread/v2/a/b.md.json');
  assert.equal(v2SidecarPath('a__b.md'), '.docthread/v2/a__b.md.json');
  assert.equal(
    v2SidecarPath('docs/review notes.md'),
    '.docthread/v2/docs/review%20notes.md.json'
  );

  const nfc = 'docs/caf\u00e9.md';
  const nfd = 'docs/cafe\u0301.md';
  assert.notEqual(v2SidecarPath(nfc), v2SidecarPath(nfd));
  assert.match(v2SidecarPath(nfc), /caf%C3%A9\.md/);
  assert.match(v2SidecarPath(nfd), /cafe%CC%81\.md/);
});

test('v2 sidecar paths reject ambiguous or non-canonical raw segments', () => {
  for (const path of ['', '/a.md', 'a.md/', 'a//b.md', './a.md', 'a/../b.md', 'a\\b.md']) {
    assert.throws(() => v2SidecarPath(path));
  }
});

test('canonical source JSON has stable field order and local keys include repository/ref', () => {
  const identity = {
    provider: 'github' as const,
    owner: 'contoso',
    repo: 'docs',
    versionType: 'branch' as const,
    ref: 'feature/review',
    path: 'docs/caf\u00e9.md',
  };
  assert.equal(
    canonicalSourceIdentityJson(identity),
    '{"provider":"github","owner":"contoso","repo":"docs","versionType":"branch","ref":"feature/review","path":"docs/caf\u00e9.md"}'
  );
  assert.notEqual(localStorageKeyV2(identity), localStorageKeyV2({ ...identity, ref: 'main' }));
  assert.notEqual(localStorageKeyV2(identity), localStorageKeyV2({ ...identity, repo: 'other' }));
});

test('decoder returns a cloned, canonicalized v2 file and enforces persisted identity', () => {
  const input = v2File();
  input.threads[0].comments[0].authorIdentityKeys = [
    'github:U_example',
    'entra:tenant-1:object-1',
  ];
  const decoded = decodeDocThreadFile(input, {
    remote: true,
    expectedSource: { provider: 'github', path: 'docs/review.md' },
  });
  assert.equal(decoded.schemaVersion, 2);
  assert.notEqual(decoded, input);
  assert.notEqual(decoded.threads[0], input.threads[0]);
  assert.deepEqual(decoded.threads[0].comments[0].authorIdentityKeys, [
    'entra:tenant-1:object-1',
    'github:U_example',
  ]);
  input.threads[0].comments[0].body = 'changed after decode';
  assert.equal(decoded.threads[0].comments[0].body, 'Ask @mayast');

  assert.throws(
    () =>
      decodeDocThreadFile(v2File(), {
        expectedSource: { provider: 'github', path: 'docs/other.md' },
      }),
    /does not match/
  );
});

test('decoder rejects unknown versions, malformed spans, routes, and identity keys', () => {
  assert.throws(() => decodeDocThreadFile({ schemaVersion: 3 }), /unknown or missing/);

  const badSpan = v2File();
  badSpan.threads[0].comments[0].mentions[0].start = 5;
  assert.throws(() => decodeDocThreadFile(badSpan), /span does not exactly match/);

  const badRoute = v2File();
  badRoute.threads[0].comments[0].mentions[0].route.identityId = 'person@example.com';
  assert.throws(() => decodeDocThreadFile(badRoute), /opaque provider identifier/);

  const badKey = v2File();
  badKey.threads[0].comments[0].authorIdentityKeys = ['entra:missing-object-id'];
  assert.throws(() => decodeDocThreadFile(badKey), /provider identity key/);
});

test('decoder rejects resolver evidence and local-only comments in remote sidecars', () => {
  const evidence = v2File();
  Object.assign(evidence.threads[0].comments[0].mentions[0], {
    mail: 'maya@contoso.example',
  });
  assert.throws(() => decodeDocThreadFile(evidence), /unknown field/);

  const local = v2File();
  const comment = local.threads[0].comments[0];
  comment.author = 'You';
  comment.authorIdentityKeys = [];
  comment.localOnly = true;
  comment.mentions = [
    { kind: 'unresolved', start: 4, length: 7, text: '@mayast', handle: 'mayast' },
  ];
  delete comment.dispatch;
  assert.equal(decodeDocThreadFile(local).threads[0].comments[0].localOnly, true);
  assert.throws(() => decodeDocThreadFile(local, { remote: true }), /localOnly/);
});

test('decoder validates per-field clocks and deletion tombstones', () => {
  const invalidClock = v2File();
  invalidClock.threads[0].clocks.anchorAt = 'yesterday';
  assert.throws(() => decodeDocThreadFile(invalidClock), /ISO 8601 UTC timestamp/);

  const invalidTombstone = v2File();
  invalidTombstone.threads[0].deletedAt = '2026-08-22T10:00:00.000Z';
  assert.throws(() => decodeDocThreadFile(invalidTombstone), /cannot predate/);
});

test('decoder supports strict legacy v1 data without returning the input object', () => {
  const legacy = {
    schemaVersion: 1,
    docPath: 'docs/review.md',
    updatedAt: CREATED,
    threads: [
      {
        id: 'legacy-thread',
        anchor: { quote: 'review', prefix: '', suffix: '', start: 5 },
        resolved: false,
        createdAt: CREATED,
        comments: [{ id: 'legacy-comment', author: 'maya', body: 'Looks good', createdAt: CREATED }],
      },
    ],
  };
  const decoded = decodeDocThreadFile(legacy);
  assert.equal(decoded.schemaVersion, 1);
  assert.notEqual(decoded.threads[0].comments[0], legacy.threads[0].comments[0]);
});
test('decodes an optional thread suggestion and is back-compatible when absent (#35)', () => {
  const withSuggestion = v2File();
  withSuggestion.threads[0].suggestion = { replacement: 'slow red', appliedAt: CREATED };
  const decoded = decodeDocThreadFile(withSuggestion);
  assert.deepEqual(decoded.threads[0].suggestion, { replacement: 'slow red', appliedAt: CREATED });

  const withoutSuggestion = v2File();
  assert.equal(decodeDocThreadFile(withoutSuggestion).threads[0].suggestion, undefined);
});

test('rejects an unknown field on a suggestion (#35)', () => {
  const bad = v2File();
  bad.threads[0].suggestion = { replacement: 'x', weight: 1 };
  assert.throws(() => decodeDocThreadFile(bad), /unknown field/);
});

test('decodes suggestion origin and rejects an unknown origin (#63)', () => {
  const ai = v2File();
  ai.threads[0].suggestion = { replacement: 'x', origin: 'ai' };
  assert.equal(decodeDocThreadFile(ai).threads[0].suggestion.origin, 'ai');

  const bad = v2File();
  bad.threads[0].suggestion = { replacement: 'x', origin: 'robot' };
  assert.throws(() => decodeDocThreadFile(bad), /unknown suggestion origin/);
});

test('decodes optional suggestion skill provenance and remains strict (#92)', () => {
  const withSkill = v2File();
  withSkill.threads[0].suggestion = { replacement: 'x', origin: 'ai', skillName: 'Brand Voice' };
  assert.equal(decodeDocThreadFile(withSkill).threads[0].suggestion?.skillName, 'Brand Voice');

  const emptySkill = v2File();
  emptySkill.threads[0].suggestion = { replacement: 'x', skillName: '' };
  assert.throws(() => decodeDocThreadFile(emptySkill), /expected a non-empty string/);
});
