import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertImmutableCommentAccepted,
  findComment,
  NotificationStateError,
  pendingGitHubDispatch,
  transitionCommentDispatch,
} from '../src/notification.ts';
import type { Comment, DocThreadFileV2, MentionReference } from '../src/types.ts';

const T0 = '2026-08-23T10:00:00.000Z';
const T1 = '2026-08-23T10:01:00.000Z';
const T2 = '2026-08-23T10:02:00.000Z';

const mention: MentionReference = {
  kind: 'resolved',
  start: 4,
  length: 6,
  text: '@maya1',
  subjectKey: 'github:U_maya',
  identityKeys: ['github:U_maya'],
  authority: 'github',
  displayName: 'Maya Stewart',
  handle: 'maya1',
  route: { kind: 'github', nodeId: 'U_maya' },
};

function comment(): Comment {
  return {
    id: 'comment-1',
    author: 'Reviewer',
    authorIdentityKeys: ['github:U_reviewer'],
    identityVersion: 1,
    mentions: [mention],
    body: 'Ask @maya1',
    createdAt: T0,
    dispatch: pendingGitHubDispatch([mention]),
  };
}

function file(value = comment()): DocThreadFileV2 {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: 'docs/review.md' },
    docPath: 'docs/review.md',
    updatedAt: T0,
    threads: [
      {
        id: 'thread-1',
        anchor: { quote: 'Ask', prefix: '', suffix: '', start: 0 },
        comments: [value],
        resolved: false,
        createdAt: T0,
      },
    ],
  };
}

test('pending dispatch uses sorted unique stable recipient keys', () => {
  assert.deepEqual(pendingGitHubDispatch([mention, mention]), {
    channel: 'github',
    state: 'pending',
    recipientKeys: ['github:U_maya'],
  });
  assert.equal(pendingGitHubDispatch([]), undefined);
});

test('dispatch claim and terminal result preserve immutable core and attempt identity', () => {
  const original = comment();
  const attempted = transitionCommentDispatch(
    file(original),
    original.id,
    {
      ...original.dispatch!,
      state: 'attempted',
      attemptId: 'attempt-1',
      attemptedAt: T1,
    },
    T1
  );
  assertImmutableCommentAccepted(original, findComment(attempted, original.id));

  const delivered = transitionCommentDispatch(
    attempted,
    original.id,
    {
      ...findComment(attempted, original.id).dispatch!,
      state: 'delivered',
      providerUrl: 'https://github.com/contoso/docs/issues/1#issuecomment-2',
    },
    T2
  );
  assert.equal(findComment(delivered, original.id).dispatch?.state, 'delivered');
  assert.equal(findComment(delivered, original.id).dispatch?.attemptId, 'attempt-1');
});

test('dispatch refuses replay, recipient changes, and immutable-core mismatch', () => {
  const original = comment();
  assert.throws(
    () =>
      transitionCommentDispatch(
        file(original),
        original.id,
        { ...original.dispatch!, state: 'delivered', attemptId: 'x', attemptedAt: T1 },
        T1
      ),
    /Invalid notification transition/
  );
  assert.throws(
    () =>
      transitionCommentDispatch(
        file(original),
        original.id,
        {
          ...original.dispatch!,
          state: 'attempted',
          recipientKeys: ['github:U_other'],
          attemptId: 'x',
          attemptedAt: T1,
        },
        T1
      ),
    /recipient set changed/
  );
  assert.throws(
    () => assertImmutableCommentAccepted(original, { ...original, body: 'Changed' }),
    (error) => error instanceof NotificationStateError
  );
});
