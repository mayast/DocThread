import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewDigest,
  buildAiSummaryPayload,
  renderDigestText,
  requestAiSummary,
} from '../src/reviewSummary.ts';
import type { Thread } from '../src/types.ts';

let seq = 0;
function thread(
  intent: 'question' | 'suggestion' | 'blocking',
  resolved: boolean,
  comments: { author: string; body: string }[]
): Thread {
  seq += 1;
  return {
    id: `t${seq}`,
    intent,
    resolved,
    createdAt: '2026-08-01T00:00:00.000Z',
    anchor: { quote: `q${seq}`, prefix: '', suffix: '', start: 0 },
    comments: comments.map((c, i) => ({
      id: `t${seq}-c${i}`,
      author: c.author,
      body: c.body,
      createdAt: '2026-08-01T00:00:00.000Z',
    })),
  } as Thread;
}

const sample: Thread[] = [
  thread('blocking', false, [{ author: 'Priya', body: 'Must fix the auth flow before ship. @maya' }]),
  thread('question', false, [
    { author: 'Sam', body: 'Does this cover the offline case?' },
    { author: 'Maya', body: 'Yes.' },
  ]),
  thread('suggestion', false, [{ author: 'Lee', body: 'Consider a shorter title.' }]),
  thread('question', true, [{ author: 'Sam', body: 'Private repos supported?' }]),
];

test('buildReviewDigest groups open threads by intent (scope open, excludes resolved)', () => {
  const d = buildReviewDigest(sample, 'open', 'Spec');
  assert.equal(d.docTitle, 'Spec');
  assert.equal(d.scope, 'open');
  assert.equal(d.blockers.length, 1);
  assert.equal(d.questions.length, 1);
  assert.equal(d.suggestions.length, 1);
  assert.equal(d.decisions.length, 0); // resolved not surfaced in open scope
  assert.equal(d.totals.open, 3);
  assert.equal(d.totals.blocking, 1);
  assert.equal(d.totals.resolved, 1);
});

test('buildReviewDigest surfaces resolved under decisions when scope is all', () => {
  const d = buildReviewDigest(sample, 'all', 'Spec');
  assert.equal(d.decisions.length, 1);
  assert.equal(d.decisions[0].resolved, true);
  assert.equal(d.blockers.length, 1);
});

test('digest items capture author, replies, waiting-on, and mentions', () => {
  const d = buildReviewDigest(sample, 'open', 'Spec');
  const blocker = d.blockers[0];
  assert.equal(blocker.author, 'Priya');
  assert.deepEqual(blocker.mentions, ['maya']);
  assert.deepEqual(blocker.waitingOn, ['maya']);
  const q = d.questions[0];
  assert.equal(q.replies, 1); // one reply after the opening comment
});

test('buildReviewDigest does not mutate its input', () => {
  const copy = JSON.parse(JSON.stringify(sample));
  buildReviewDigest(sample, 'all', 'Spec');
  assert.deepEqual(sample, copy);
});

test('renderDigestText handles zero threads with a friendly message', () => {
  const d = buildReviewDigest([], 'open', 'Empty Doc');
  const text = renderDigestText(d);
  assert.match(text, /No review threads yet/);
  assert.match(text, /Empty Doc/);
});

test('renderDigestText handles resolved-only in open scope', () => {
  const resolvedOnly = [thread('question', true, [{ author: 'Sam', body: 'Done?' }])];
  const text = renderDigestText(buildReviewDigest(resolvedOnly, 'open', 'Doc'));
  assert.match(text, /No open threads/);
});

test('renderDigestText groups blockers, questions, suggestions', () => {
  const text = renderDigestText(buildReviewDigest(sample, 'open', 'Spec'));
  assert.match(text, /Blockers \(1\)/);
  assert.match(text, /Open questions \(1\)/);
  assert.match(text, /Suggestions \(1\)/);
});

test('renderDigestText truncates a very long headline', () => {
  const long = 'x'.repeat(400);
  const d = buildReviewDigest([thread('blocking', false, [{ author: 'A', body: long }])], 'open', 'Doc');
  assert.ok(d.blockers[0].headline.length <= 140);
  assert.match(d.blockers[0].headline, /\u2026$/);
});

test('buildAiSummaryPayload includes only in-scope threads with bodies/intents/mentions', () => {
  const openPayload = buildAiSummaryPayload(sample, 'open', 'Spec');
  assert.equal(openPayload.threads.length, 3);
  const allPayload = buildAiSummaryPayload(sample, 'all', 'Spec');
  assert.equal(allPayload.threads.length, 4);
  assert.equal(openPayload.threads[0].intent, 'blocking');
  assert.deepEqual(openPayload.threads[0].comments[0].mentions, ['maya']);
});

test('requestAiSummary returns null text when no endpoint is configured', async () => {
  const r = await requestAiSummary('', buildAiSummaryPayload(sample, 'open', 'Spec'));
  assert.equal(r.text, null);
  assert.match(r.reason || '', /no endpoint/);
});

test('requestAiSummary returns the summary text on a successful response', async () => {
  const fakeFetch = async () =>
    ({ ok: true, json: async () => ({ summary: '  Two blockers remain.  ' }) }) as any;
  const r = await requestAiSummary('https://ai.example/summarize', buildAiSummaryPayload(sample, 'open', 'Spec'), fakeFetch);
  assert.equal(r.text, 'Two blockers remain.');
});

test('requestAiSummary degrades gracefully on a non-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as any;
  const r = await requestAiSummary('https://ai.example/summarize', buildAiSummaryPayload(sample, 'open', 'Spec'), fakeFetch);
  assert.equal(r.text, null);
  assert.match(r.reason || '', /503/);
});

test('requestAiSummary never throws on a network error', async () => {
  const fakeFetch = async () => {
    throw new Error('network down');
  };
  const r = await requestAiSummary('https://ai.example/summarize', buildAiSummaryPayload(sample, 'open', 'Spec'), fakeFetch as any);
  assert.equal(r.text, null);
  assert.match(r.reason || '', /network down/);
});
