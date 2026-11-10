import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attributeLocalComments,
  initializeLegacyThreadClocks,
  mergeDocThreadFiles,
  ReviewMergeError,
  sanitizeLegacyThreadsForMigration,
} from '../src/reviewPersistence.ts';
import type {
  Comment,
  DocThreadFileV2,
  NotificationDispatch,
  Thread,
} from '../src/types.ts';

const T0 = '2026-08-23T10:00:00.000Z';
const T1 = '2026-08-23T10:01:00.000Z';
const T2 = '2026-08-23T10:02:00.000Z';
const T3 = '2026-08-23T10:03:00.000Z';

function comment(id: string, createdAt = T0): Comment {
  return {
    id,
    author: 'Maya Stewart',
    authorLogin: 'mayast',
    authorIdentityKeys: ['entra:tenant:maya'],
    identityVersion: 1,
    mentions: [],
    body: `Comment ${id}`,
    createdAt,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
    comments: [comment('base')],
    resolved: false,
    intent: 'question',
    createdAt: T0,
    clocks: { resolutionAt: T0, intentAt: T0, anchorAt: T0 },
    ...overrides,
  };
}

function file(value: Thread): DocThreadFileV2 {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: 'docs/review.md' },
    docPath: 'docs/review.md',
    threads: [value],
    updatedAt: T3,
  };
}

function dispatchComment(dispatch: NotificationDispatch): Comment {
  return {
    id: 'dispatch-comment',
    author: 'Reviewer',
    authorIdentityKeys: ['github:U_reviewer'],
    identityVersion: 1,
    body: 'Ask @maya',
    createdAt: T0,
    mentions: [
      {
        kind: 'resolved',
        start: 4,
        length: 5,
        text: '@maya',
        subjectKey: 'github:U_maya',
        identityKeys: ['github:U_maya'],
        authority: 'github',
        displayName: 'Maya Stewart',
        handle: 'maya',
        route: { kind: 'github', nodeId: 'U_maya' },
      },
    ],
    dispatch,
  };
}

function dispatchFile(dispatch: NotificationDispatch): DocThreadFileV2 {
  return file(thread({ comments: [dispatchComment(dispatch)] }));
}

test('merge unions concurrent comments by stable ID', () => {
  const local = file(thread({ comments: [comment('base'), comment('local', T1)] }));
  const remote = file(thread({ comments: [comment('base'), comment('remote', T2)] }));
  const merged = mergeDocThreadFiles(local, remote);
  assert.deepEqual(
    merged.threads[0].comments.map((item) => item.id),
    ['base', 'remote', 'local']
  );
});

test('merge rejects conflicting immutable data under the same comment ID', () => {
  const localComment = comment('base');
  const remoteComment = comment('base');
  Object.assign(localComment, { body: 'Changed under the same ID' });
  assert.throws(
    () => mergeDocThreadFiles(file(thread({ comments: [localComment] })), file(thread({ comments: [remoteComment] }))),
    /conflicting immutable core/
  );
});

test('resolution, intent, and anchor merge independently by their clocks', () => {
  const local = file(
    thread({
      resolved: true,
      anchor: { quote: 'local anchor', prefix: '', suffix: '', start: 1 },
      clocks: { resolutionAt: T3, intentAt: T0, anchorAt: T1 },
    })
  );
  const remote = file(
    thread({
      intent: 'blocking',
      anchor: { quote: 'remote anchor', prefix: '', suffix: '', start: 2 },
      clocks: { resolutionAt: T0, intentAt: T2, anchorAt: T2 },
    })
  );
  const merged = mergeDocThreadFiles(local, remote);
  assert.equal(merged.threads[0].resolved, true);
  assert.equal(merged.threads[0].intent, 'blocking');
  assert.equal(merged.threads[0].anchor.quote, 'remote anchor');

  const tied = file(thread({ resolved: true, clocks: { resolutionAt: T1 } }));
  assert.throws(() => mergeDocThreadFiles(tied, file(thread({ clocks: { resolutionAt: T1 } }))), /same clock/);
});

test('legacy clock initialization uses createdAt without mutating the thread', () => {
  const legacy = thread({ clocks: undefined });
  assert.deepEqual(initializeLegacyThreadClocks(legacy), {
    resolutionAt: T0,
    intentAt: T0,
    anchorAt: T0,
  });
  assert.equal(legacy.clocks, undefined);
});

test('remote tombstones are terminal and reject stale replies or mutations', () => {
  const local = file(thread());
  const remote = file(thread({ deletedAt: T2 }));
  assert.equal(mergeDocThreadFiles(local, remote).threads[0].deletedAt, T2);

  const staleReply = file(thread({ comments: [comment('base'), comment('late', T3)] }));
  assert.throws(
    () => mergeDocThreadFiles(staleReply, remote),
    (error) => error instanceof ReviewMergeError && error.code === 'stale-tombstone'
  );

  const staleResolve = file(
    thread({ resolved: true, clocks: { resolutionAt: T3, intentAt: T0, anchorAt: T0 } })
  );
  assert.throws(
    () => mergeDocThreadFiles(staleResolve, remote),
    (error) => error instanceof ReviewMergeError && error.code === 'stale-tombstone'
  );

  const localDelete = file(thread({ deletedAt: T1 }));
  const laterRemoteMutation = file(
    thread({ intent: 'suggestion', clocks: { resolutionAt: T0, intentAt: T3, anchorAt: T0 } })
  );
  const deleted = mergeDocThreadFiles(localDelete, laterRemoteMutation).threads[0];
  assert.equal(deleted.deletedAt, T1);
  assert.equal(deleted.intent, 'suggestion');
});

test('dispatch state advances monotonically and terminal divergence is corruption', () => {
  const pending: NotificationDispatch = {
    channel: 'github',
    state: 'pending',
    recipientKeys: ['github:U_maya'],
  };
  const attempted: NotificationDispatch = {
    ...pending,
    state: 'attempted',
    attemptId: 'attempt-1',
    attemptedAt: T1,
  };
  const delivered: NotificationDispatch = {
    ...attempted,
    state: 'delivered',
    providerUrl: 'https://github.com/contoso/docs/issues/1',
  };
  const failed: NotificationDispatch = {
    ...attempted,
    state: 'failed',
    errorCode: 'not-sent',
  };

  assert.equal(
    mergeDocThreadFiles(dispatchFile(attempted), dispatchFile(pending)).threads[0].comments[0]
      .dispatch?.state,
    'attempted'
  );
  assert.equal(
    mergeDocThreadFiles(dispatchFile(attempted), dispatchFile(delivered)).threads[0].comments[0]
      .dispatch?.state,
    'delivered'
  );
  assert.throws(
    () => mergeDocThreadFiles(dispatchFile(failed), dispatchFile(delivered)),
    /divergent terminal/
  );
});

test('remote merge refuses local-only comments while local merge retains them', () => {
  const localOnly = comment('local');
  Object.assign(localOnly, {
    author: 'You',
    authorIdentityKeys: [],
    localOnly: true,
  });
  const local = file(thread({ comments: [localOnly] }));
  const emptyRemote = file(thread({ comments: [] }));
  assert.throws(
    () => mergeDocThreadFiles(local, emptyRemote),
    (error) => error instanceof ReviewMergeError && error.code === 'local-only'
  );
  assert.equal(
    mergeDocThreadFiles(local, emptyRemote, { target: 'local' }).threads[0].comments[0].localOnly,
    true
  );
});

test('explicit attribution rewrites only local comments and leaves mentions unresolved', () => {
  const local = comment('local');
  Object.assign(local, {
    author: 'You',
    authorIdentityKeys: [],
    localOnly: true,
    mentions: [
      {
        kind: 'unresolved',
        start: 8,
        length: 5,
        text: '@maya',
        handle: 'maya',
      },
    ],
    body: 'Comment @maya',
  });
  const remote = comment('remote');
  const result = attributeLocalComments(thread({ comments: [remote, local] }).comments.length
    ? [thread({ comments: [remote, local] })]
    : [], {
    author: 'Alex Reviewer',
    authorLogin: 'alexr_contoso',
    authorIdentityKeys: ['github:U_alex'],
  });
  assert.equal(result.count, 1);
  assert.equal(result.threads[0].comments[0].author, 'Maya Stewart');
  assert.equal(result.threads[0].comments[1].author, 'Alex Reviewer');
  assert.equal(result.threads[0].comments[1].localOnly, undefined);
  assert.equal(result.threads[0].comments[1].mentions?.[0].kind, 'unresolved');
});

test('v1 migration strips email domains from legacy author metadata', () => {
  const legacy = comment('legacy');
  Object.assign(legacy, {
    author: 'mayast@contoso.example',
    authorLogin: 'mayast@contoso.example',
    identityVersion: undefined,
    authorIdentityKeys: undefined,
    mentions: undefined,
  });
  const original = thread({ comments: [legacy] });
  const sanitized = sanitizeLegacyThreadsForMigration([original]);
  assert.equal(sanitized[0].comments[0].author, 'mayast (legacy)');
  assert.equal(sanitized[0].comments[0].authorLogin, undefined);
  assert.equal(original.comments[0].author, 'mayast@contoso.example');
  assert.doesNotMatch(JSON.stringify(sanitized), /contoso\.example/);
});

test('v1 migration redacts email addresses embedded in composite author text', () => {
  const legacy = comment('legacy-composite');
  Object.assign(legacy, {
    author: 'Maya Stewart <maya@contoso.example>',
    authorLogin: 'maya@contoso.example (legacy)',
    identityVersion: undefined,
    authorIdentityKeys: undefined,
    mentions: undefined,
  });
  const sanitized = sanitizeLegacyThreadsForMigration([thread({ comments: [legacy] })]);
  assert.equal(sanitized[0].comments[0].author, 'Maya Stewart <maya (legacy)>');
  assert.equal(sanitized[0].comments[0].authorLogin, undefined);
  assert.doesNotMatch(JSON.stringify(sanitized), /contoso\.example/);
});
test('merge keeps a suggestion and applies appliedAt as a terminal transition (#35)', () => {
  const localFile = file(thread({ suggestion: { replacement: 'slow red' } }));
  const remoteFile = file(
    thread({ suggestion: { replacement: 'slow red', appliedAt: T1 } })
  );
  const merged = mergeDocThreadFiles(localFile, remoteFile);
  assert.deepEqual(merged.threads[0].suggestion, { replacement: 'slow red', appliedAt: T1 });
});

test('merge rejects conflicting suggestion replacements as corruption (#35)', () => {
  const localFile = file(thread({ suggestion: { replacement: 'aaa' } }));
  const remoteFile = file(thread({ suggestion: { replacement: 'bbb' } }));
  assert.throws(() => mergeDocThreadFiles(localFile, remoteFile), ReviewMergeError);
});

test('merge takes the earliest appliedAt on a double-apply (#35)', () => {
  const localFile = file(thread({ suggestion: { replacement: 'x', appliedAt: T2 } }));
  const remoteFile = file(thread({ suggestion: { replacement: 'x', appliedAt: T1 } }));
  const merged = mergeDocThreadFiles(localFile, remoteFile);
  assert.equal(merged.threads[0].suggestion?.appliedAt, T1);
});

test('merge keeps suggestion provenance and rejects a conflict (#63)', () => {
  const a = file(thread({ suggestion: { replacement: 'x', origin: 'ai' } }));
  const b = file(thread({ suggestion: { replacement: 'x', origin: 'ai' } }));
  assert.equal(mergeDocThreadFiles(a, b).threads[0].suggestion?.origin, 'ai');

  const c = file(thread({ suggestion: { replacement: 'x', origin: 'ai' } }));
  const d = file(thread({ suggestion: { replacement: 'x', origin: 'human' } }));
  assert.throws(() => mergeDocThreadFiles(c, d), ReviewMergeError);
});

test('merge keeps suggestion skill provenance and rejects a conflict (#92)', () => {
  const a = file(thread({ suggestion: { replacement: 'x', origin: 'ai', skillName: 'Brand Voice' } }));
  const b = file(thread({ suggestion: { replacement: 'x', origin: 'ai', skillName: 'Brand Voice' } }));
  assert.equal(mergeDocThreadFiles(a, b).threads[0].suggestion?.skillName, 'Brand Voice');

  const c = file(thread({ suggestion: { replacement: 'x', skillName: 'Brand Voice' } }));
  const d = file(thread({ suggestion: { replacement: 'x', skillName: 'Security Standard' } }));
  assert.throws(() => mergeDocThreadFiles(c, d), ReviewMergeError);
});
