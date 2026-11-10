import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptFeedbackOutcome, captureReviewOperation, feedbackMessage, hasUnsentInput, isCurrentReviewOperation, leaveSourceReason, type FeedbackNotice } from '../src/reviewUi.ts';
import type { DocThreadFileV2 } from '../src/types.ts';
import type { SourceTarget } from '../src/source.ts';
import { SAMPLE_DOC, SAMPLE_THREADS } from '../src/sample.ts';
import { clearDocumentDraft, combineAdoReviewCopies, documentDraftKey, loadAdoLocalReview, loadDocumentDraft, sameReviewThreads, storeDocumentDraft } from '../src/reviewRecovery.ts';
import { createAdoWorkItemClient, decodeAdoReviewSnapshot } from '../src/ado.ts';

const pending: FeedbackNotice = { sourceKey: 'github:one/main/document.md', version: 3, phase: 'pending' };

test('an operation keeps its original source, feedback and revision across an await', async () => {
  const source: SourceTarget = { kind: 'github', owner: 'example', repo: 'original', versionType: 'branch', ref: 'main', path: 'docs/review.md' };
  const file: DocThreadFileV2 = { schemaVersion: 2, source: { provider: 'github', path: source.path }, docPath: source.path, threads: [], updatedAt: '2026-09-09T10:00:00.000Z' };
  const operation = captureReviewOperation(source, 'original-source-key', file, 'original-revision', 4);
  source.repo = 'another-repository';
  file.docPath = 'another-document.md';
  file.source.path = 'another-document.md';
  await Promise.resolve();
  assert.equal(operation.source?.kind, 'github');
  assert.equal(operation.source && 'repo' in operation.source ? operation.source.repo : null, 'original');
  assert.equal(operation.sourceKey, 'original-source-key');
  assert.equal(operation.file.docPath, 'docs/review.md');
  assert.equal(operation.file.schemaVersion === 2 ? operation.file.source.path : null, 'docs/review.md');
  assert.equal(operation.revision, 'original-revision');
  assert.equal(operation.version, 4);
});

test('a sample operation cannot acquire a remote target later', () => {
  const operation = captureReviewOperation(null, 'sample', { schemaVersion: 1, docPath: 'sample', threads: [], updatedAt: '2026-09-09T10:00:00.000Z' }, null, 0);
  assert.equal(operation.source, null);
  assert.equal(operation.sourceKey, 'sample');
  assert.equal(operation.revision, null);
});

test('a delayed operation cannot cancel another source or newer feedback autosave', () => {
  const operation = { sourceKey: 'source-one', version: 3 };
  assert.equal(isCurrentReviewOperation(operation, 'source-one', 3), true);
  assert.equal(isCurrentReviewOperation(operation, 'source-one', 4), false);
  assert.equal(isCurrentReviewOperation(operation, 'source-two', 3), false);
});

test('a save receipt cannot mark another source or newer feedback saved', () => {
  assert.equal(acceptFeedbackOutcome(pending, { ...pending, sourceKey: 'github:two/main/document.md', phase: 'saved' }), pending);
  assert.equal(acceptFeedbackOutcome(pending, { ...pending, version: 2, phase: 'saved' }), pending);
  assert.equal(acceptFeedbackOutcome(pending, { ...pending, version: 2, phase: 'failed', error: 'late failure' }), pending);
  assert.equal(acceptFeedbackOutcome(pending, { ...pending, phase: 'saved' }).phase, 'saved');
});

test('local, pending, failure and confirmed provider receipts have distinct wording', () => {
  assert.equal(feedbackMessage({ ...pending, phase: 'local' }, 'GitHub'), 'Feedback in this browser');
  assert.equal(feedbackMessage(pending, 'GitHub'), 'Feedback waiting to save');
  assert.equal(feedbackMessage({ ...pending, phase: 'saving' }, 'GitHub'), 'Saving feedback...');
  assert.equal(feedbackMessage({ ...pending, phase: 'saved' }, 'GitHub'), 'Feedback saved to GitHub');
  assert.equal(feedbackMessage({ ...pending, phase: 'failed', error: 'Conflict' }, 'GitHub'), 'Feedback save failed: Conflict');
});

test('unsent comments, exact replacements, applied documents and replies all guard leaving', () => {
  const empty = { comment: '', replacementChanged: false, documentChanged: false, replies: [] };
  assert.equal(hasUnsentInput(empty), false);
  assert.equal(hasUnsentInput({ ...empty, comment: '   ' }), false);
  assert.equal(hasUnsentInput({ ...empty, comment: 'Review this' }), true);
  assert.equal(hasUnsentInput({ ...empty, replacementChanged: true }), true);
  assert.equal(hasUnsentInput({ ...empty, documentChanged: true }), true);
  assert.equal(hasUnsentInput({ ...empty, replies: [{ body: 'Keep this reply', mentions: [] }] }), true);
});

test('in-flight work blocks switching and failed saves still require a recovery decision', () => {
  assert.equal(leaveSourceReason(true, true, pending), 'busy');
  assert.equal(leaveSourceReason(false, true, pending), 'draft');
  assert.equal(leaveSourceReason(false, false, pending), 'feedback');
  assert.equal(leaveSourceReason(false, false, { ...pending, phase: 'failed' }), 'feedback');
  assert.equal(leaveSourceReason(false, false, { ...pending, phase: 'saved' }), null);
  assert.equal(leaveSourceReason(false, false, { ...pending, phase: 'local' }), null);
});

test('updated sample instructions retain an exact unique quote for every example thread', () => {
  for (const thread of SAMPLE_THREADS) {
    const start = SAMPLE_DOC.indexOf(thread.anchor.quote);
    assert.ok(start >= 0, thread.id);
    assert.equal(SAMPLE_DOC.indexOf(thread.anchor.quote, start + 1), -1, thread.id);
  }
});

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test('Markdown recovery reuses the existing envelope and preserves exact source and draft content', () => {
  const storage = memoryStorage();
  storeDocumentDraft(storage, 'github:original/main/review.md', '');
  storeDocumentDraft(storage, 'github:other/main/review.md', '# Other draft');
  const draft = loadDocumentDraft(storage, 'github:original/main/review.md');
  assert.equal(draft?.schemaVersion, 1);
  assert.equal(draft?.markdown, '');
  assert.deepEqual(draft?.threads, []);
  assert.equal(loadDocumentDraft(storage, 'github:other/main/review.md')?.markdown, '# Other draft');
  assert.equal(loadDocumentDraft(storage, 'github:original/tag/review.md'), null);
});

test('old save completion cannot delete a newer document draft', () => {
  const storage = memoryStorage();
  storeDocumentDraft(storage, 'source', 'first edit');
  storeDocumentDraft(storage, 'source', 'newer edit');
  clearDocumentDraft(storage, 'source', 'first edit');
  assert.equal(loadDocumentDraft(storage, 'source')?.markdown, 'newer edit');
  clearDocumentDraft(storage, 'source', 'newer edit');
  assert.equal(loadDocumentDraft(storage, 'source'), null);
});

test('corrupt or foreign draft records are never restored or silently removed', () => {
  const storage = memoryStorage();
  storeDocumentDraft(storage, 'original', 'original text');
  const raw = storage.getItem(documentDraftKey('original'))!;
  storage.setItem(documentDraftKey('other'), raw);
  assert.throws(() => loadDocumentDraft(storage, 'other'), /does not match/);
  assert.equal(storage.getItem(documentDraftKey('other')), raw);
  storage.setItem(documentDraftKey('original'), '{broken');
  assert.throws(() => loadDocumentDraft(storage, 'original'));
  assert.equal(storage.getItem(documentDraftKey('original')), '{broken');
});

test('a failed draft-storage write is observable and keeps the previous recovery copy', () => {
  const storage = memoryStorage();
  storeDocumentDraft(storage, 'source', 'recoverable');
  const failing = { ...storage, setItem: () => { throw new Error('storage full'); } };
  assert.throws(() => storeDocumentDraft(failing, 'source', 'newer'), /storage full/);
  assert.equal(loadDocumentDraft(storage, 'source')?.markdown, 'recoverable');
});

test('review comparison ignores display-only anchoring and property ordering, not missing feedback', () => {
  const original = structuredClone(SAMPLE_THREADS[0]);
  const reordered = { ...original, comments: original.comments.map(comment => Object.fromEntries(Object.entries(comment).reverse()) as typeof comment), located: true, confidence: 'exact' as const };
  assert.equal(sameReviewThreads({ threads: [original] }, { threads: [reordered] }), true);
  assert.equal(sameReviewThreads({ threads: [original] }, { threads: [] }), false);
  const changed = structuredClone(original);
  changed.comments[0] = { ...changed.comments[0], body: 'Unsent feedback' };
  assert.equal(sameReviewThreads({ threads: [original] }, { threads: [changed] }), false);
});

test('ADO recovery uses the existing native snapshot codec without removing name-based authors', () => {
  const snapshot = {
    schemaVersion: 1,
    docPath: 'ado-source-key',
    threads: [{ ...SAMPLE_THREADS[0], comments: [{ id: 'local-ado', author: 'ADO reviewer', authorIdentityKeys: [], identityVersion: 1, mentions: [], body: 'Unsent ADO feedback', createdAt: '2026-09-09T10:00:00.000Z' }] }],
    updatedAt: '2026-09-09T10:00:00.000Z',
  };
  assert.deepEqual(decodeAdoReviewSnapshot(JSON.stringify(snapshot)), snapshot);
  assert.equal(decodeAdoReviewSnapshot('not JSON'), null);
});

test('local ADO copies are source-bound and corrupt copies are kept for recovery', () => {
  const storage = memoryStorage();
  const snapshot = { schemaVersion: 1, docPath: 'ado-source-key', threads: [], updatedAt: '2026-09-09T10:00:00.000Z' };
  storage.setItem('ado-source-key', JSON.stringify(snapshot));
  assert.deepEqual(loadAdoLocalReview(storage, 'ado-source-key'), snapshot);
  storage.setItem('another-source', JSON.stringify(snapshot));
  assert.throws(() => loadAdoLocalReview(storage, 'another-source'), /has not been removed/);
  assert.equal(storage.getItem('another-source'), JSON.stringify(snapshot));
  storage.setItem('ado-source-key', '{broken');
  assert.throws(() => loadAdoLocalReview(storage, 'ado-source-key'));
  assert.equal(storage.getItem('ado-source-key'), '{broken');
});

test('explicit ADO recovery combines additions from both copies without dropping identities', () => {
  const shared = { schemaVersion: 1 as const, docPath: 'ado-source-key', threads: [structuredClone(SAMPLE_THREADS[0])], updatedAt: '2026-09-09T10:00:00.000Z' };
  const local = structuredClone(shared);
  local.threads[0].comments.push({ id: 'local-addition', author: 'Local author', authorIdentityKeys: [], identityVersion: 1, mentions: [], body: 'Local feedback', createdAt: '2026-09-09T10:01:00.000Z' });
  shared.threads[0].comments.push({ id: 'shared-addition', author: 'Another author', body: 'Shared feedback', createdAt: '2026-09-09T10:02:00.000Z' });
  const combined = combineAdoReviewCopies(local, shared);
  assert.deepEqual(combined.threads[0].comments.map(comment => comment.id), ['sample-question-c1', 'sample-question-c2', 'shared-addition', 'local-addition']);
  assert.deepEqual(combined.threads[0].comments.find(comment => comment.id === 'local-addition')?.authorIdentityKeys, []);
  assert.equal(local.threads[0].comments.length, 3);
  assert.equal(shared.threads[0].comments.length, 3);
});

test('ADO recovery preserves conflict and tombstone rules instead of choosing a winning copy', () => {
  const shared = { schemaVersion: 1 as const, docPath: 'ado-source-key', threads: [structuredClone(SAMPLE_THREADS[0])], updatedAt: '2026-09-09T10:00:00.000Z' };
  const local = structuredClone(shared);
  local.threads[0].comments[0] = { ...local.threads[0].comments[0], body: 'Conflicting immutable body' };
  assert.throws(() => combineAdoReviewCopies(local, shared), /conflicting immutable/);
  assert.throws(() => combineAdoReviewCopies({ ...local, docPath: 'another-source' }, shared), /different sources/);
  const stale = structuredClone(shared);
  stale.threads[0].comments.push({ id: 'late-reply', author: 'Reviewer', body: 'After deletion', createdAt: '2026-09-09T10:03:00.000Z' });
  shared.threads[0].deletedAt = '2026-09-09T10:02:00.000Z';
  assert.throws(() => combineAdoReviewCopies(stale, shared), /stale reply/);
});

test('ADO discussion write failure is rejected rather than reported saved', async () => {
  const methods: string[] = [];
  const client = createAdoWorkItemClient({ fetch: async (_input, init) => {
    methods.push(init?.method || 'GET');
    return new Response(JSON.stringify(init?.method === 'POST' ? { message: 'write rejected' } : { comments: [] }), { status: init?.method === 'POST' ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(client.saveReview({ kind: 'ado-workitem', organization: 'example', project: 'Docs', id: 42 }, 'discussion', { schemaVersion: 1, docPath: 'source', threads: [], updatedAt: '2026-09-09T10:00:00.000Z' }));
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('an ADO discussion read failure cannot trigger a replacement write', async () => {
  const methods: string[] = [];
  const client = createAdoWorkItemClient({ fetch: async (_input, init) => {
    methods.push(init?.method || 'GET');
    return new Response(JSON.stringify({ message: 'read failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(client.saveReview({ kind: 'ado-workitem', organization: 'example', project: 'Docs', id: 42 }, 'discussion', { schemaVersion: 1, docPath: 'source', threads: [], updatedAt: '2026-09-09T10:00:00.000Z' }));
  assert.deepEqual(methods, ['GET']);
});

test('an unavailable ADO review attachment is a read failure, not an absent review', async () => {
  const client = createAdoWorkItemClient({ fetch: async (input) => {
    const attachment = String(input).includes('/attachments/');
    const value = attachment ? { message: 'attachment unavailable' } : { relations: [{ rel: 'AttachedFile', attributes: { name: 'docthread-review.json' }, url: 'https://dev.azure.com/example/Docs/_apis/wit/attachments/review' }] };
    return new Response(JSON.stringify(value), { status: attachment ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(client.readReview({ kind: 'ado-workitem', organization: 'example', project: 'Docs', id: 42 }, 'attachment'));
});
