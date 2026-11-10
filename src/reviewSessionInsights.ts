export const REVIEW_SESSION_LIMIT = 1000;

export type FindingAcceptanceOutcome = 'failed' | 'posted_as_thread' | 'applied_to_draft';
export type SessionDecision = Exclude<FindingAcceptanceOutcome, 'failed'> | 'dismissed';
export type SessionOrigin = 'local' | 'ai' | 'unknown';
export type SessionPass = 'compliance' | 'security' | 'readiness' | 'other';
export type SessionSeverity = 'important' | 'nit' | 'unknown';

export interface SessionRun {
  readonly id: string;
  readonly generation: number;
}

export interface SessionObservation {
  readonly id: string;
  readonly runId: string;
  readonly origin: SessionOrigin;
  readonly pass: SessionPass;
  readonly severity: SessionSeverity;
  readonly outcome: 'pending' | SessionDecision;
}

export interface ReviewSessionInsights {
  readonly status: 'off' | 'capturing' | 'paused';
  readonly generation: number;
  readonly nextRun: number;
  readonly activeRun: SessionRun | null;
  readonly observations: readonly SessionObservation[];
  readonly completedRuns: number;
  readonly omittedRuns: number;
  readonly omittedObservations: number;
  readonly runsWhilePaused: number;
}

export interface SessionFindingMetadata {
  readonly origin?: unknown;
  readonly pass?: unknown;
  readonly severity?: unknown;
}

export function createReviewSessionInsights(): ReviewSessionInsights {
  return {
    status: 'off', generation: 0, nextRun: 1, activeRun: null,
    observations: [], completedRuns: 0, omittedRuns: 0, omittedObservations: 0, runsWhilePaused: 0,
  };
}

export function clearReviewSessionInsights(
  session: ReviewSessionInsights,
  enabled = session.status !== 'off'
): ReviewSessionInsights {
  return {
    ...createReviewSessionInsights(),
    status: enabled ? 'capturing' : 'off',
    generation: session.generation + 1,
    nextRun: session.nextRun,
  };
}

export function setReviewSessionCapture(session: ReviewSessionInsights, enabled: boolean): ReviewSessionInsights {
  return enabled === (session.status !== 'off') ? session : clearReviewSessionInsights(session, enabled);
}

export function startReviewSessionRun(session: ReviewSessionInsights): {
  session: ReviewSessionInsights;
  run: SessionRun | null;
} {
  if (session.status === 'off') return { session, run: null };
  if (session.status === 'paused') {
    return { session: { ...session, runsWhilePaused: session.runsWhilePaused + 1 }, run: null };
  }
  const run = Object.freeze({ id: `run-${session.nextRun}`, generation: session.generation });
  return { session: { ...session, activeRun: run, nextRun: session.nextRun + 1 }, run };
}

export function completeReviewSessionRun(
  session: ReviewSessionInsights,
  run: SessionRun | null,
  displayed: readonly SessionFindingMetadata[]
): ReviewSessionInsights {
  if (session.status !== 'capturing' || !run || run.generation !== session.generation ||
      session.activeRun?.id !== run.id) return session;
  if (session.observations.length + displayed.length > REVIEW_SESSION_LIMIT) {
    return {
      ...session, status: 'paused', activeRun: null,
      omittedRuns: session.omittedRuns + 1,
      omittedObservations: session.omittedObservations + displayed.length,
    };
  }
  const cohort = displayed.map((metadata, index): SessionObservation => Object.freeze({
    id: `${run.id}-observation-${index + 1}`,
    runId: run.id,
    origin: metadata.origin === 'local' || metadata.origin === 'ai' ? metadata.origin : 'unknown',
    pass: metadata.pass === 'compliance' || metadata.pass === 'security' || metadata.pass === 'readiness'
      ? metadata.pass : 'other',
    severity: metadata.severity === 'important' || metadata.severity === 'nit' ? metadata.severity : 'unknown',
    outcome: 'pending',
  }));
  return {
    ...session, activeRun: null, completedRuns: session.completedRuns + 1,
    observations: Object.freeze([...session.observations, ...cohort]),
  };
}

export function recordReviewSessionOutcome(
  session: ReviewSessionInsights,
  observationId: string | undefined,
  outcome: FindingAcceptanceOutcome | 'dismissed'
): ReviewSessionInsights {
  if (session.status === 'off' || (outcome !== 'posted_as_thread' && outcome !== 'applied_to_draft' && outcome !== 'dismissed')) return session;
  const observation = session.observations.find(candidate => candidate.id === observationId);
  if (!observation || observation.outcome !== 'pending') return session;
  return {
    ...session,
    observations: Object.freeze(session.observations.map(candidate => candidate === observation
      ? Object.freeze({ ...candidate, outcome }) : candidate)),
  };
}

export interface SessionDecisionCounts {
  observed: number;
  pending: number;
  posted: number;
  applied: number;
  dismissed: number;
  numerator: number;
  denominator: number;
  rate: number | null;
}

function decisionCounts(observations: readonly SessionObservation[]): SessionDecisionCounts {
  const counts: SessionDecisionCounts = {
    observed: observations.length, pending: 0, posted: 0, applied: 0, dismissed: 0,
    numerator: 0, denominator: 0, rate: null,
  };
  for (const observation of observations) {
    if (observation.outcome === 'posted_as_thread') counts.posted += 1;
    else if (observation.outcome === 'applied_to_draft') counts.applied += 1;
    else if (observation.outcome === 'dismissed') counts.dismissed += 1;
    else counts.pending += 1;
  }
  counts.numerator = counts.posted + counts.applied;
  counts.denominator = counts.numerator + counts.dismissed;
  counts.rate = counts.denominator === 0 ? null : counts.numerator / counts.denominator;
  return counts;
}

export function summarizeReviewSessionInsights(session: ReviewSessionInsights) {
  const origins = ['local', 'ai', 'unknown'] as const;
  const passes = ['compliance', 'security', 'readiness', 'other'] as const;
  const severities = ['important', 'nit', 'unknown'] as const;
  return {
    schema_version: 1,
    metric: 'session_decision_uptake',
    scope: 'tab_document_capture_session',
    counts: decisionCounts(session.observations),
    by_origin: Object.fromEntries(origins.map(origin => [origin,
      decisionCounts(session.observations.filter(observation => observation.origin === origin))])),
    by_pass: Object.fromEntries(passes.map(pass => [pass,
      decisionCounts(session.observations.filter(observation => observation.pass === pass))])),
    by_severity: Object.fromEntries(severities.map(severity => [severity,
      decisionCounts(session.observations.filter(observation => observation.severity === severity))])),
    coverage: {
      capture_state: session.status,
      observation_limit: REVIEW_SESSION_LIMIT,
      captured_runs: session.completedRuns,
      omitted_runs_capacity: session.omittedRuns,
      omitted_observations_capacity: session.omittedObservations,
      runs_started_while_paused: session.runsWhilePaused,
    },
    notes: [
      'Opt-in, final displayed cohorts only; hidden findings and runs before capture are not observed.',
      'Repeated runs count as observations, not unique findings, reviewers or documents.',
      'Pending observations are excluded from the decision denominator.',
      'Decision uptake is not correctness, AI quality, approval, source-save success or notification delivery.',
      'Whole runs exceeding capacity are omitted; capture pauses without interrupting review.',
      'Memory only until off, clear, source/account change, sign-out, teardown or reload. Downloaded exports cannot be recalled.',
    ],
    not_collected: {
      cycle_time: 'not_collected',
      reviewer_reach: 'not_collected',
      reviewer_roles: 'not_collected',
      readiness_lift: 'not_collected',
      policy_comparison: 'not_collected',
      skill_comparison: 'not_collected',
      saved_change_success: 'not_collected',
    },
  };
}

export function exportReviewSessionInsights(session: ReviewSessionInsights): string {
  return JSON.stringify(summarizeReviewSessionInsights(session), null, 2) + '\n';
}