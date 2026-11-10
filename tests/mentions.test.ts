import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeMentionQuery,
  finalizeMentionReferences,
  includeUnresolvedMentionReferences,
  reconcileMentionReferences,
  updateMentionQuery,
} from '../src/mentions.ts';
import type { MentionReference } from '../src/types.ts';

test('empty input and caret zero never create a mention without an at sign', () => {
  assert.equal(activeMentionQuery('', 0), null);
  assert.equal(activeMentionQuery('Plain comment', 0), null);
  assert.equal(activeMentionQuery('@reviewer', 0), null);
  assert.equal(updateMentionQuery('', 0, null), null);
  assert.equal(updateMentionQuery('', 0, { start: 0, term: 'reviewer' }), null);
  assert.deepEqual(activeMentionQuery('@', 1), { start: 0, term: '' });
});

test('mention session accepts full names and email addresses', () => {
  let query = activeMentionQuery('Please ask @', 12);
  assert.deepEqual(query, { start: 11, term: '' });
  query = updateMentionQuery('Please ask @Maya Stewart', 24, query);
  assert.equal(query?.term, 'Maya Stewart');
  query = updateMentionQuery('Please ask @mayast@contoso.example', 35, query);
  assert.equal(query?.term, 'mayast@contoso.example');
});

test('mention session opens after punctuation but not inside an email', () => {
  assert.deepEqual(activeMentionQuery('(@', 2), { start: 1, term: '' });
  assert.equal(activeMentionQuery('maya@', 5), null);
  assert.equal(updateMentionQuery('@maya\nnext', 10, { start: 0, term: '' }), null);
});

test('mention spans shift after edits before them and drop when edited', () => {
  const mention: MentionReference = {
    kind: 'resolved',
    start: 6,
    length: 7,
    text: '@mayast',
    subjectKey: 'entra:t:1',
    identityKeys: ['entra:t:1'],
    authority: 'entra',
    displayName: 'Maya Stewart',
    handle: 'mayast',
    route: { kind: 'none' },
  };

  const shifted = reconcileMentionReferences('Hello @mayast', 'Well, Hello @mayast', [mention]);
  assert.equal(shifted[0].start, 12);
  assert.equal(
    reconcileMentionReferences('Hello @mayast', 'Hello @mayax', [mention]).length,
    0
  );
});

test('picker replacement rebases a later structured mention', () => {
  const later: MentionReference = {
    kind: 'unresolved',
    start: 10,
    length: 4,
    text: '@bob',
    handle: 'bob',
  };
  const rebased = reconcileMentionReferences(
    '@ma hello @bob',
    '@mayast  hello @bob',
    [later]
  );
  assert.equal(rebased.length, 1);
  assert.equal(rebased[0].start, 15);
  assert.equal(rebased[0].text, '@bob');
});

test('free-typed handles become unresolved spans but email domains do not', () => {
  const body = 'Ask @newperson, not maya@microsoft.com.';
  const mentions = includeUnresolvedMentionReferences(body, []);
  assert.deepEqual(mentions, [
    {
      kind: 'unresolved',
      start: 4,
      length: 10,
      text: '@newperson',
      handle: 'newperson',
    },
  ]);
});

test('resolved picker spans are not duplicated as unresolved mentions', () => {
  const resolved: MentionReference = {
    kind: 'resolved',
    start: 4,
    length: 7,
    text: '@mayast',
    subjectKey: 'entra:t:1',
    identityKeys: ['entra:t:1'],
    authority: 'entra',
    displayName: 'Maya Stewart',
    handle: 'mayast',
    route: { kind: 'none' },
  };
  assert.deepEqual(includeUnresolvedMentionReferences('Ask @mayast', [resolved]), [resolved]);
});

test('submission preserves resolved spans when the body has outer whitespace', () => {
  const resolved: MentionReference = {
    kind: 'resolved',
    start: 6,
    length: 7,
    text: '@mayast',
    subjectKey: 'github:U_maya',
    identityKeys: ['github:U_maya'],
    authority: 'github',
    displayName: 'Maya Stewart',
    handle: 'mayast',
    route: { kind: 'github', nodeId: 'U_maya' },
  };
  const body = '  Ask @mayast  ';
  assert.deepEqual(finalizeMentionReferences(body, [resolved]), [resolved]);
});
