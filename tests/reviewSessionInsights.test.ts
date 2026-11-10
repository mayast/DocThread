import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_SESSION_LIMIT,
  clearReviewSessionInsights,
  completeReviewSessionRun,
  createReviewSessionInsights,
  exportReviewSessionInsights,
  recordReviewSessionOutcome,
  setReviewSessionCapture,
  startReviewSessionRun,
  summarizeReviewSessionInsights,
  type ReviewSessionInsights,
  type FindingAcceptanceOutcome,
  type SessionFindingMetadata,
} from '../src/reviewSessionInsights.ts';

const LOCAL = { origin: 'local', pass: 'compliance', severity: 'important' };

function capture(displayed: readonly SessionFindingMetadata[], session = setReviewSessionCapture(createReviewSessionInsights(), true)) {
  const started = startReviewSessionRun(session);
  return completeReviewSessionRun(started.session, started.run, displayed);
}

test('capture is off by default and cannot retroactively observe a run', () => {
  const empty = createReviewSessionInsights();
  const started = startReviewSessionRun(empty);
  assert.equal(started.run, null);
  assert.equal(started.session, empty);
  const enabled = setReviewSessionCapture(empty, true);
  assert.equal(completeReviewSessionRun(enabled, started.run, [LOCAL]), enabled);
  assert.equal(enabled.observations.length, 0);
});

test('each rerun allocates fresh IDs even when findings reuse local-0 and ai-0', () => {
  const metadata = [{ ...LOCAL, id: 'local-0' }, { ...LOCAL, origin: 'ai', id: 'ai-0' }];
  const first = capture(metadata);
  const second = capture(metadata, first);
  assert.equal(second.completedRuns, 2);
  assert.equal(new Set(second.observations.map(observation => observation.id)).size, 4);
  assert.equal(new Set(second.observations.map(observation => observation.runId)).size, 2);
  assert.ok(second.observations.every(observation => observation.outcome === 'pending'));
  assert.equal(JSON.stringify(second).includes('local-0'), false);
  assert.equal(JSON.stringify(second).includes('ai-0'), false);
});

test('only the active run completes, and repeated completion is idempotent', () => {
  const first = startReviewSessionRun(setReviewSessionCapture(createReviewSessionInsights(), true));
  const second = startReviewSessionRun(first.session);
  assert.equal(completeReviewSessionRun(second.session, first.run, [LOCAL]), second.session);
  const completed = completeReviewSessionRun(second.session, second.run, [LOCAL]);
  assert.equal(completed.observations.length, 1);
  assert.equal(completeReviewSessionRun(completed, second.run, [LOCAL]), completed);
});

test('the final displayed cohort is a frozen metadata-only snapshot', () => {
  const metadata = [{ ...LOCAL }];
  const captured = capture(metadata);
  metadata[0].origin = 'ai';
  metadata.push({ ...LOCAL });
  assert.equal(captured.observations.length, 1);
  assert.equal(captured.observations[0].origin, 'local');
  assert.ok(Object.isFrozen(captured.observations));
  assert.ok(Object.isFrozen(captured.observations[0]));
});

test('only the first successful outcome wins; failed and repeated callbacks are inert', () => {
  for (const outcome of ['posted_as_thread', 'applied_to_draft', 'dismissed'] as const) {
    const captured = capture([LOCAL]);
    const observationId = captured.observations[0].id;
    assert.equal(recordReviewSessionOutcome(captured, observationId, 'failed'), captured);
    assert.equal(recordReviewSessionOutcome(captured, undefined, outcome), captured);
    const decided = recordReviewSessionOutcome(captured, observationId, outcome);
    assert.equal(decided.observations[0].outcome, outcome);
    for (const repeated of ['posted_as_thread', 'applied_to_draft', 'dismissed'] as const) {
      assert.equal(recordReviewSessionOutcome(decided, observationId, repeated), decided);
    }
    assert.equal(captured.observations[0].outcome, 'pending');
  }
});

test('combined post/apply is one applied observation, not two verdicts', () => {
  const captured = capture([LOCAL]);
  const applied = recordReviewSessionOutcome(captured, captured.observations[0].id, 'applied_to_draft');
  assert.equal(applied.observations.length, 1);
  assert.equal(applied.observations[0].outcome, 'applied_to_draft');
});

test('unexpected runtime outcomes cannot introduce free text into a record', () => {
  const captured = capture([LOCAL]);
  const malformed = 'PRIVATE callback text person@example.test' as FindingAcceptanceOutcome;
  assert.equal(recordReviewSessionOutcome(captured, captured.observations[0].id, malformed), captured);
});

test('clear and off invalidate in-flight capture and old observation callbacks', () => {
  for (const reset of [
    (session: ReviewSessionInsights) => clearReviewSessionInsights(session),
    (session: ReviewSessionInsights) => setReviewSessionCapture(session, false),
  ]) {
    const captured = capture([LOCAL]);
    const started = startReviewSessionRun(captured);
    const cleared = reset(started.session);
    assert.equal(cleared.observations.length, 0);
    assert.equal(cleared.completedRuns, 0);
    const resumed = setReviewSessionCapture(cleared, true);
    assert.equal(completeReviewSessionRun(resumed, started.run, [LOCAL]), resumed);
    const next = capture([LOCAL], resumed);
    assert.notEqual(next.observations[0].id, captured.observations[0].id);
    assert.equal(recordReviewSessionOutcome(next, captured.observations[0].id, 'dismissed'), next);
  }
});

test('normalization bounds origins, passes and severity without retaining free text', () => {
  const sentinel = 'PRIVATE prose person@example.test https://private.test/repo/spec.md SECRET-SKILL';
  const captured = capture([{
    origin: sentinel, pass: sentinel, severity: sentinel, title: sentinel, rationale: sentinel,
    anchor: { quote: sentinel, start: 999 }, replacement: sentinel, skillName: sentinel,
    id: sentinel, email: sentinel, timestamp: '2026-09-09T10:12:13Z',
  } as SessionFindingMetadata, {}, { origin: 'ai', pass: 'security', severity: 'nit' },
  { origin: 'local', pass: 'readiness', severity: 'important' }]);
  assert.deepEqual(captured.observations.map(({ origin, pass, severity }) => ({ origin, pass, severity })), [
    { origin: 'unknown', pass: 'other', severity: 'unknown' },
    { origin: 'unknown', pass: 'other', severity: 'unknown' },
    { origin: 'ai', pass: 'security', severity: 'nit' },
    { origin: 'local', pass: 'readiness', severity: 'important' },
  ]);
  assert.deepEqual(Object.keys(captured.observations[0]).sort(), ['id', 'origin', 'outcome', 'pass', 'runId', 'severity']);
  assert.equal(JSON.stringify(captured).includes(sentinel), false);
  assert.equal(JSON.stringify(captured).includes('2026-09-09'), false);
});

test('capacity includes pending, accepts the exact bound and refuses the next run in full', () => {
  const captured = capture(Array.from({ length: REVIEW_SESSION_LIMIT - 1 }, () => LOCAL));
  const full = capture([LOCAL], captured);
  assert.equal(full.status, 'capturing');
  assert.equal(full.observations.length, REVIEW_SESSION_LIMIT);
  const overflow = capture([LOCAL, LOCAL], full);
  assert.equal(overflow.status, 'paused');
  assert.equal(overflow.observations, full.observations);
  assert.equal(overflow.completedRuns, 2);
  assert.equal(overflow.omittedRuns, 1);
  assert.equal(overflow.omittedObservations, 2);
  const skipped = startReviewSessionRun(overflow);
  assert.equal(skipped.run, null);
  assert.equal(skipped.session.runsWhilePaused, 1);
  assert.equal(skipped.session.observations, full.observations);
  const decided = recordReviewSessionOutcome(overflow, full.observations[0].id, 'dismissed');
  assert.equal(decided.observations[0].outcome, 'dismissed');
  assert.equal(decided.observations.length, REVIEW_SESSION_LIMIT);
  const cleared = clearReviewSessionInsights(decided);
  assert.equal(cleared.status, 'capturing');
  assert.equal(cleared.observations.length, 0);
  assert.equal(cleared.omittedRuns, 0);
});

test('an oversized first run pauses without a partial cohort; review input is unchanged', () => {
  const displayed = Array.from({ length: REVIEW_SESSION_LIMIT + 1 }, () => ({ ...LOCAL }));
  const before = JSON.stringify(displayed);
  const overflow = capture(displayed);
  assert.equal(overflow.status, 'paused');
  assert.equal(overflow.observations.length, 0);
  assert.equal(overflow.completedRuns, 0);
  assert.equal(overflow.omittedObservations, REVIEW_SESSION_LIMIT + 1);
  assert.equal(JSON.stringify(displayed), before);
  assert.equal(setReviewSessionCapture(overflow, false).status, 'off');
});

test('decision uptake is 3/4 = 0.75 for posted=2 applied=1 dismissed=1 pending=6', () => {
  let session = capture(Array.from({ length: 10 }, () => LOCAL));
  const outcomes = ['posted_as_thread', 'posted_as_thread', 'applied_to_draft', 'dismissed'] as const;
  outcomes.forEach((outcome, index) => {
    session = recordReviewSessionOutcome(session, session.observations[index].id, outcome);
  });
  assert.deepEqual(summarizeReviewSessionInsights(session).counts, {
    observed: 10, pending: 6, posted: 2, applied: 1, dismissed: 1,
    numerator: 3, denominator: 4, rate: 0.75,
  });
});

test('empty and pending-only cohorts have null rates, not zero', () => {
  for (const session of [createReviewSessionInsights(), capture([LOCAL])]) {
    const summary = summarizeReviewSessionInsights(session);
    assert.equal(summary.counts.rate, null);
    assert.equal(summary.counts.denominator, 0);
    assert.equal(summary.by_origin.ai.rate, null);
    assert.equal(summary.by_pass.other.rate, null);
  }
});

test('origin, pass and severity buckets separate local, AI and unknown observations', () => {
  let session = capture([LOCAL, { origin: 'ai', pass: 'readiness', severity: 'nit' },
    { origin: 'unrecognized', pass: 'custom policy name', severity: 'custom' },
    { origin: 'ai', pass: 'security', severity: 'important' }]);
  session = recordReviewSessionOutcome(session, session.observations[0].id, 'posted_as_thread');
  session = recordReviewSessionOutcome(session, session.observations[1].id, 'dismissed');
  session = recordReviewSessionOutcome(session, session.observations[2].id, 'applied_to_draft');
  const summary = summarizeReviewSessionInsights(session);
  assert.equal(summary.by_origin.local.rate, 1);
  assert.equal(summary.by_origin.ai.rate, 0);
  assert.equal(summary.by_origin.ai.pending, 1);
  assert.equal(summary.by_origin.unknown.applied, 1);
  assert.equal(summary.by_pass.compliance.posted, 1);
  assert.equal(summary.by_pass.readiness.dismissed, 1);
  assert.equal(summary.by_pass.security.pending, 1);
  assert.equal(summary.by_pass.other.applied, 1);
  assert.equal(summary.by_severity.unknown.observed, 1);
  for (const breakdown of [summary.by_origin, summary.by_pass, summary.by_severity]) {
    for (const count of ['observed', 'pending', 'posted', 'applied', 'dismissed', 'numerator', 'denominator'] as const) {
      assert.equal(Object.values(breakdown).reduce((total, bucket) => total + bucket[count], 0), summary.counts[count]);
    }
  }
});

test('summary coverage reports repeated runs, whole-run omission and runs while paused', () => {
  let session = capture([LOCAL]);
  session = capture([LOCAL], session);
  session = capture(Array.from({ length: REVIEW_SESSION_LIMIT }, () => LOCAL), session);
  session = startReviewSessionRun(session).session;
  const summary = summarizeReviewSessionInsights(session);
  assert.deepEqual(summary.coverage, {
    capture_state: 'paused', observation_limit: 1000, captured_runs: 2,
    omitted_runs_capacity: 1, omitted_observations_capacity: 1000, runs_started_while_paused: 1,
  });
  assert.equal(summary.counts.observed, 2);
  assert.equal(JSON.parse(exportReviewSessionInsights(session)).coverage.capture_state, 'paused');
});

test('versioned export rebuilds only allowed aggregate fields and never exports records or IDs', () => {
  const sentinel = 'PRIVATE prose person@example.test https://private.test/repo/spec.md SECRET-SKILL';
  const session = capture([{ ...LOCAL, title: sentinel, skillName: sentinel } as SessionFindingMetadata]);
  const before = JSON.stringify(session);
  const text = exportReviewSessionInsights({ ...session, extra: sentinel } as ReviewSessionInsights);
  const exported = JSON.parse(text);
  assert.equal(JSON.stringify(session), before);
  assert.equal(exported.schema_version, 1);
  assert.deepEqual(Object.keys(exported).sort(), [
    'by_origin', 'by_pass', 'by_severity', 'counts', 'coverage', 'metric', 'not_collected', 'notes', 'schema_version', 'scope',
  ]);
  assert.deepEqual(Object.keys(exported.by_origin), ['local', 'ai', 'unknown']);
  assert.deepEqual(Object.keys(exported.by_pass), ['compliance', 'security', 'readiness', 'other']);
  assert.deepEqual(Object.keys(exported.by_severity), ['important', 'nit', 'unknown']);
  assert.deepEqual(Object.keys(exported.not_collected).sort(), [
    'cycle_time', 'policy_comparison', 'readiness_lift', 'reviewer_reach', 'reviewer_roles', 'saved_change_success', 'skill_comparison',
  ]);
  assert.ok(Object.values(exported.not_collected).every(value => value === 'not_collected'));
  for (const forbidden of [sentinel, session.observations[0].id, session.observations[0].runId,
    '"observations"', '"id"', '"runId"', '"timestamp"', '"anchor"', '"replacement"', '"skillName"']) {
    assert.equal(text.includes(forbidden), false, `Forbidden export value: ${forbidden}`);
  }
  assert.ok(exported.notes.some((note: string) => note.includes('Opt-in')));
  assert.ok(exported.notes.some((note: string) => note.includes('not correctness')));
});