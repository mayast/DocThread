import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseReviewPolicy,
  applyPolicy,
  enabledPassIds,
  DEFAULT_POLICY,
  type ReviewPolicy,
  type PolicyFinding,
} from '../src/reviewPolicy.ts';

const REVIEW_MD = `# Review instructions

## Passes
- Bugs: logic errors, broken edge cases
- Security: injection risks, PII in logs
- Compliance: matches spec.md and design principles

## What Important means here
Reserve Important for findings that break behavior or leak data.

## Cap the nits
Report at most 3 nits per review; summarize the rest as a count.

## Do not report
- generated
- vendor/
`;

function finding(severity: 'important' | 'nit', quote: string, prefix = '', suffix = ''): PolicyFinding {
  return { severity, anchor: { quote, prefix, suffix, start: 0 } };
}

test('parseReviewPolicy reads passes, important def, nit cap, and exclusions', () => {
  const p = parseReviewPolicy(REVIEW_MD);
  assert.equal(p.source, 'REVIEW.md');
  assert.deepEqual(
    p.passes.map((x) => x.id),
    ['bugs', 'security', 'compliance']
  );
  assert.match(p.importantDef, /break behavior or leak data/);
  assert.equal(p.nitCap, 3);
  assert.deepEqual(p.exclude, ['generated', 'vendor/']);
});

test('parseReviewPolicy falls back to defaults for empty or sparse input', () => {
  assert.equal(parseReviewPolicy('').source, 'default');
  const p = parseReviewPolicy('# Just a title\n\nNo policy sections here.');
  assert.deepEqual(p.passes, DEFAULT_POLICY.passes);
  assert.equal(p.nitCap, DEFAULT_POLICY.nitCap);
  assert.deepEqual(p.exclude, []);
  assert.equal(p.source, 'REVIEW.md');
});

test('parseReviewPolicy reads a bare "at most N nits" phrase anywhere', () => {
  const p = parseReviewPolicy('## Passes\n- Bugs: x\n\nPlease report at most 8 nits total.');
  assert.equal(p.nitCap, 8);
});

test('enabledPassIds reflects the policy passes', () => {
  const ids = enabledPassIds(parseReviewPolicy(REVIEW_MD));
  assert.ok(ids.has('bugs') && ids.has('security') && ids.has('compliance'));
  assert.ok(!ids.has('style'));
});

test('applyPolicy ranks important ahead of nits and preserves input order within severity', () => {
  const findings = [
    finding('nit', 'n1'),
    finding('important', 'i1'),
    finding('nit', 'n2'),
    finding('important', 'i2'),
  ];
  const { shown, hiddenNits } = applyPolicy(findings, { ...DEFAULT_POLICY, nitCap: 5 });
  assert.deepEqual(
    shown.map((f) => f.anchor.quote),
    ['i1', 'i2', 'n1', 'n2']
  );
  assert.equal(hiddenNits, 0);
});

test('applyPolicy caps nits and reports the hidden count', () => {
  const findings = [
    finding('nit', 'n1'),
    finding('nit', 'n2'),
    finding('nit', 'n3'),
    finding('important', 'i1'),
  ];
  const { shown, hiddenNits } = applyPolicy(findings, { ...DEFAULT_POLICY, nitCap: 1 });
  assert.deepEqual(
    shown.map((f) => f.anchor.quote),
    ['i1', 'n1']
  );
  assert.equal(hiddenNits, 2);
});

test('applyPolicy drops findings whose anchored context contains an exclude token', () => {
  const policy: ReviewPolicy = { ...DEFAULT_POLICY, exclude: ['generated'] };
  const findings = [
    finding('important', 'boom', 'in the generated ', ' file'),
    finding('important', 'keep', 'in the real ', ' file'),
  ];
  const { shown } = applyPolicy(findings, policy);
  assert.deepEqual(
    shown.map((f) => f.anchor.quote),
    ['keep']
  );
});
