import assert from 'node:assert/strict';
import test from 'node:test';

import {
  localReviewPass,
  runLocalReview,
  buildReviewPayload,
  requestAiReview,
  type ReviewFinding,
} from '../src/aiReview.ts';
import { DEFAULT_POLICY, parseReviewPolicy, applyPolicy, type ReviewPolicy } from '../src/reviewPolicy.ts';
import { applySuggestion } from '../src/suggestion.ts';

const DOC = `# Feature spec

## Overview
The service must be fast and scalable. The cache strategy is TBD.

## Security
The api key is stored in config, TODO document rotation.
`;

test('localReviewPass anchors fixable findings to their sentence and secrets to the term', () => {
  const findings = localReviewPass(DOC, DEFAULT_POLICY);
  const quotes = findings.map((f) => f.anchor.quote.toLowerCase());
  // Fixable findings anchor to the whole containing sentence (so the proposed
  // replacement reads as a natural sentence)...
  assert.ok(quotes.some((q) => q.includes('the cache strategy is tbd')));
  assert.ok(quotes.some((q) => q.includes('the service must be fast and scalable')));
  // ...while a possible-secret finding stays anchored to the flagged term.
  assert.ok(quotes.some((q) => q.includes('api key')));
  // Every finding's quote is actually present at its anchor start.
  for (const f of findings) {
    assert.equal(DOC.slice(f.anchor.start, f.anchor.start + f.anchor.quote.length), f.anchor.quote);
  }
});

test('localReviewPass assigns severity/intent/pass per detector', () => {
  const findings = localReviewPass(DOC, DEFAULT_POLICY);
  const tbd = findings.find((f) => f.title === 'Unresolved placeholder' && f.anchor.quote.includes('TBD'))!;
  assert.equal(tbd.severity, 'important');
  assert.equal(tbd.intent, 'blocking');
  assert.equal(tbd.pass, 'compliance');
  const secret = findings.find((f) => f.title === 'Possible secret in the document')!;
  assert.equal(secret.pass, 'security');
  assert.equal(secret.severity, 'important');
});

test('localReviewPass only runs passes enabled by the policy', () => {
  const policy: ReviewPolicy = {
    ...DEFAULT_POLICY,
    passes: [{ id: 'security', label: 'Security', description: '' }],
  };
  const findings = localReviewPass(DOC, policy);
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.pass === 'security'));
});

test('local findings propose a natural full-sentence replacement (#108)', () => {
  const findings = localReviewPass(DOC, DEFAULT_POLICY);
  // Placeholder: the replacement is the whole sentence with the placeholder
  // rewritten in place — a directly-usable A → B, not an instruction.
  const tbd = findings.find((f) => f.title === 'Unresolved placeholder' && f.anchor.quote.includes('TBD'))!;
  assert.ok(tbd.replacement && tbd.replacement.length > 0);
  assert.notEqual(tbd.replacement, tbd.anchor.quote);
  assert.ok(tbd.replacement!.startsWith('The cache strategy is'));
  assert.ok(!tbd.replacement!.includes('TBD'));
  assert.ok(!/^\[/.test(tbd.replacement!)); // not a bracketed instruction
  // Vague term: the concrete measurable stand-in reads in the sentence.
  const vague = findings.find((f) => f.title === 'Vague, unmeasurable term' && f.anchor.quote.includes('fast'))!;
  assert.ok(vague.replacement!.startsWith('The service must be'));
  assert.ok(vague.replacement!.includes('latency budget'));
  assert.ok(!vague.replacement!.includes('fast')); // the vague word is gone
  // ...while a possible-secret finding intentionally has no auto-fix (manual review).
  const secret = findings.find((f) => f.title === 'Possible secret in the document')!;
  assert.equal(secret.replacement, undefined);
});

test('a local finding replacement applies at its anchor via the #35 suggestion path (#108)', () => {
  const findings = localReviewPass(DOC, DEFAULT_POLICY);
  const tbd = findings.find((f) => f.title === 'Unresolved placeholder' && f.anchor.quote.includes('TBD'))!;
  const result = applySuggestion(DOC, tbd.anchor, tbd.replacement!);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Applying swaps the whole sentence for the natural replacement; TBD is gone.
  assert.ok(result.text.includes(tbd.replacement!));
  assert.ok(!result.text.includes('The cache strategy is TBD'));
});

test('runLocalReview applies the policy cap to nits', () => {
  const doc = 'It must be fast, scalable, robust, seamless, intuitive, and performant.';
  const policy: ReviewPolicy = { ...DEFAULT_POLICY, nitCap: 2 };
  const { shown, hiddenNits } = runLocalReview(doc, policy);
  const nits = shown.filter((f) => f.severity === 'nit');
  assert.equal(nits.length, 2);
  assert.ok(hiddenNits >= 3);
});

test('buildReviewPayload carries only the doc and the policy', () => {
  const payload = buildReviewPayload(DOC, 'Spec', parseReviewPolicy(''));
  assert.equal(payload.docTitle, 'Spec');
  assert.equal(payload.markdown, DOC);
  assert.ok(Array.isArray(payload.policy.passes));
  assert.equal(payload.policy.nitCap, DEFAULT_POLICY.nitCap);
  assert.equal('skill' in payload, false);
});

test('buildReviewPayload carries an optional resolved skill', () => {
  const payload = buildReviewPayload(DOC, 'Spec', DEFAULT_POLICY, {
    name: 'Security Standard',
    body: 'Never inline secrets.',
  });
  assert.deepEqual(payload.skill, { name: 'Security Standard', body: 'Never inline secrets.' });
});

test('requestAiReview degrades gracefully with no endpoint', async () => {
  const r = await requestAiReview('', DOC, 'Spec', DEFAULT_POLICY);
  assert.deepEqual(r, { ok: false, reason: 'no endpoint configured' });
});

test('requestAiReview anchors AI findings by quote and skips unanchorable ones', async () => {
  const fakeFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.ok(body.policy.passes.length > 0);
    assert.equal(body.skill.name, 'Brand Voice');
    return {
      ok: true,
      json: async () => ({
        findings: [
          { title: 'Ambiguous', rationale: 'clarify', quote: 'fast and scalable', intent: 'question', severity: 'nit', pass: 'compliance' },
          { title: 'Not in doc', rationale: 'x', quote: 'THIS TEXT IS ABSENT', severity: 'important' },
          { title: 'With fix', rationale: 'y', quote: 'TBD', severity: 'important', intent: 'blocking', replacement: 'Redis, 5-minute TTL' },
        ],
      }),
    };
  }) as unknown as typeof fetch;
  const r = await requestAiReview('https://ai.example/review', DOC, 'Spec', DEFAULT_POLICY, { name: 'Brand Voice', body: 'Use active voice.' }, fakeFetch);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.findings.length, 2); // the absent-quote finding is skipped
  const fix = r.findings.find((f) => f.title === 'With fix')!;
  assert.equal(fix.replacement, 'Redis, 5-minute TTL');
  assert.equal(fix.skillName, 'Brand Voice');
  assert.equal(fix.origin, 'ai');
  assert.equal(DOC.slice(fix.anchor.start, fix.anchor.start + 3), 'TBD');
});

test('requestAiReview normalizes bad intent/severity and never throws on error', async () => {
  const okFetch = (async () => ({
    ok: true,
    json: async () => ({ findings: [{ title: 't', quote: 'TBD', intent: 'bogus', severity: 'huge' }] }),
  })) as unknown as typeof fetch;
  const r = await requestAiReview('https://ai.example/review', DOC, 'Spec', DEFAULT_POLICY, okFetch);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.findings[0].intent, 'question');
  assert.equal(r.findings[0].severity, 'nit');

  const boomFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const err = await requestAiReview('https://ai.example/review', DOC, 'Spec', DEFAULT_POLICY, boomFetch);
  assert.equal(err.ok, false);
  if (err.ok) return;
  assert.match(err.reason, /network down/);
});

test('applyPolicy over AI findings enforces the same governance', () => {
  const findings: ReviewFinding[] = [
    { id: '1', anchor: { quote: 'a', prefix: '', suffix: '', start: 0 }, intent: 'question', severity: 'nit', pass: 'compliance', title: 't', rationale: '', origin: 'ai' },
    { id: '2', anchor: { quote: 'b', prefix: '', suffix: '', start: 1 }, intent: 'question', severity: 'nit', pass: 'compliance', title: 't', rationale: '', origin: 'ai' },
  ];
  const { shown, hiddenNits } = applyPolicy(findings, { ...DEFAULT_POLICY, nitCap: 1 });
  assert.equal(shown.length, 1);
  assert.equal(hiddenNits, 1);
});
