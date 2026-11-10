import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessReadiness,
  renderReadinessText,
  buildReadinessPayload,
  requestAiReadiness,
  spanAnchor,
  DEFAULT_RUBRIC,
} from '../src/readiness.ts';

const STRONG_SPEC = `# Payments status panel

## Overview
This spec adds a claim-status panel to the customer portal so users can track claims.

## Requirements
- Show the four claim states.
- Cache responses to respect the 50 rps rate limit.

## Non-goals
- We are not building an admin editor in this change.

## Acceptance criteria
- [ ] The panel renders all four states.
- [ ] Latency is under 200ms p95.

## Success metrics
- Support tickets about claim status drop by 30%.

## Dependencies and risks
- Depends on the claims-core API; assumes the gateway JWT is present.

## Structure
Rendered via StatusPanel.tsx.
`;

test('assessReadiness gives a strong spec a high grade with no gaps', () => {
  const a = assessReadiness(STRONG_SPEC, 'Payments status panel');
  assert.equal(a.empty, false);
  assert.equal(a.source, 'local');
  assert.equal(a.gaps.length, 0);
  assert.equal(a.score, 100);
  assert.equal(a.grade, 'A');
  assert.equal(a.label, 'ready');
});

test('assessReadiness flags an empty document friendly, not a wall of gaps', () => {
  const a = assessReadiness('   \n  ', 'Empty');
  assert.equal(a.empty, true);
  assert.equal(a.score, 0);
  assert.equal(a.grade, 'F');
  assert.equal(a.gaps.length, 1);
  assert.equal(a.gaps[0].id, 'empty');
});

test('assessReadiness surfaces missing critical sections as ordered gaps', () => {
  const weak = 'Some loose notes about a thing we might build. It should be fast.';
  const a = assessReadiness(weak, 'Weak');
  const ids = a.gaps.map((g) => g.id);
  assert.ok(ids.includes('acceptanceCriteria'), 'missing acceptance criteria flagged');
  assert.ok(ids.includes('nonGoals'));
  assert.ok(ids.includes('successMetrics'));
  // Critical gaps sort ahead of important/minor ones.
  assert.equal(a.gaps[0].severity, 'critical');
  // Score is well below passing.
  assert.ok(a.score < 60, `expected failing score, got ${a.score}`);
  assert.equal(a.grade, 'F');
  assert.ok(a.gaps.some((g) => g.replacement?.includes('## Acceptance criteria')));
});

test('assessReadiness flags unresolved placeholders with an anchor and count', () => {
  const md = '# Doc\n\n## Acceptance criteria\n- [ ] done\n\nThe API is TBD and the schema is TODO.';
  const a = assessReadiness(md, 'Doc');
  const gap = a.gaps.find((g) => g.id === 'noUnresolved');
  assert.ok(gap, 'placeholder gap present');
  assert.match(gap!.title, /2 unresolved/);
  assert.ok(gap!.anchor, 'placeholder gap is anchored');
  assert.equal(gap!.anchor!.quote, 'TBD');
});

test('assessReadiness flags vague language as a minor, anchored gap', () => {
  const md = '# Doc\n\n## Acceptance criteria\n- [ ] x\n\nIt must be fast and user-friendly.';
  const a = assessReadiness(md, 'Doc');
  const gap = a.gaps.find((g) => g.id === 'measurableLanguage');
  assert.ok(gap);
  assert.equal(gap!.severity, 'minor');
  assert.ok(gap!.anchor);
});

test('assessReadiness never mutates its input and reports every check', () => {
  const md = '# Doc\nHello world this is a body long enough to assess.';
  const before = md;
  const a = assessReadiness(md, 'Doc');
  assert.equal(md, before);
  assert.equal(a.checks.length, DEFAULT_RUBRIC.length);
  for (const c of a.checks) assert.ok(typeof c.passed === 'boolean');
});

test('grade thresholds map correctly across the score range', () => {
  // Construct docs that pass increasing portions of the rubric is fiddly; assert
  // the mapping indirectly via known-good and known-bad specs plus a mid doc.
  assert.equal(assessReadiness(STRONG_SPEC, 't').grade, 'A');
  const mid =
    '# T\n\n## Overview\nWhy.\n\n## Requirements\n- a\n\n## Acceptance criteria\n- [ ] x\n\nHas structure and a list.';
  const a = assessReadiness(mid, 't');
  assert.ok(['B', 'C', 'D'].includes(a.grade), `unexpected grade ${a.grade} (score ${a.score})`);
});

test('spanAnchor builds a quote/prefix/suffix window', () => {
  const src = 'aaaa TARGET bbbb';
  const anchor = spanAnchor(src, 5, 6);
  assert.equal(anchor.quote, 'TARGET');
  assert.equal(anchor.prefix, 'aaaa ');
  assert.equal(anchor.suffix, ' bbbb');
  assert.equal(anchor.start, 5);
});

test('renderReadinessText produces a copyable summary with numbered gaps', () => {
  const a = assessReadiness('Loose notes, definitely not ready.', 'X');
  const text = renderReadinessText(a);
  assert.match(text, /AI-readiness of "X"/);
  assert.match(text, /grade F/);
  assert.match(text, /Gaps \(/);
});

test('renderReadinessText reports a clean pass', () => {
  const text = renderReadinessText(assessReadiness(STRONG_SPEC, 'X'));
  assert.match(text, /No gaps found/);
});

test('buildReadinessPayload includes only doc title and markdown', () => {
  const payload = buildReadinessPayload('# Hi', 'Title');
  assert.deepEqual(payload, { docTitle: 'Title', markdown: '# Hi' });
  assert.deepEqual(buildReadinessPayload('', ''), { docTitle: 'Untitled document', markdown: '' });
});

test('buildReadinessPayload can include an optional resolved skill', () => {
  assert.deepEqual(buildReadinessPayload('# Hi', 'Title', { name: 'PRD Skill', body: 'Use measurable outcomes.' }), {
    docTitle: 'Title',
    markdown: '# Hi',
    skill: { name: 'PRD Skill', body: 'Use measurable outcomes.' },
  });
});

test('requestAiReadiness degrades gracefully with no endpoint', async () => {
  const r = await requestAiReadiness('', '# Doc', 'Doc');
  assert.deepEqual(r, { ok: false, reason: 'no endpoint configured' });
});

test('requestAiReadiness posts the payload and normalizes the response', async () => {
  const md = '# Doc\n\nThe cache layer is unspecified.';
  const fakeFetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.markdown, md);
    assert.equal(body.skill.name, 'PRD Skill');
    return {
      ok: true,
      json: async () => ({
        score: 72.6,
        grade: 'C',
        gaps: [
          { title: 'Cache unspecified', detail: 'Define eviction', severity: 'important', quote: 'cache layer', replacement: 'cache layer with a 5-minute TTL' },
          { title: 'Bad severity', detail: 'x', severity: 'nonsense' },
        ],
      }),
    };
  }) as unknown as typeof fetch;
  const r = await requestAiReadiness('https://ai.example/readiness', md, 'Doc', { name: 'PRD Skill', body: 'Use measurable outcomes.' }, fakeFetch);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.assessment.source, 'ai');
  assert.equal(r.assessment.score, 73); // rounded + clamped
  assert.equal(r.assessment.grade, 'C');
  assert.equal(r.assessment.gaps.length, 2);
  const anchored = r.assessment.gaps.find((g) => g.title === 'Cache unspecified');
  assert.ok(anchored!.anchor, 'quote found in doc → anchored');
  assert.equal(anchored!.replacement, 'cache layer with a 5-minute TTL');
  assert.equal(anchored!.skillName, 'PRD Skill');
  const fallback = r.assessment.gaps.find((g) => g.title === 'Bad severity');
  assert.equal(fallback!.severity, 'important'); // normalized
});

test('requestAiReadiness reports a reason on HTTP error and never throws', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  const r = await requestAiReadiness('https://ai.example/readiness', '# Doc', 'Doc', fakeFetch);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /503/);
});

test('requestAiReadiness falls back when the endpoint returns no score', async () => {
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ gaps: [] }) })) as unknown as typeof fetch;
  const r = await requestAiReadiness('https://ai.example/readiness', '# Doc', 'Doc', fakeFetch);
  assert.equal(r.ok, false);
});

test('requestAiReadiness swallows network errors', async () => {
  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const r = await requestAiReadiness('https://ai.example/readiness', '# Doc', 'Doc', fakeFetch);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /network down/);
});
