// AI-readiness / spec-completeness score (#44).
//
// Grades the current document against an AI Implementation Readiness Standard —
// "is this PRD/spec ready to hand to a coding agent?" — and returns a score/grade
// plus a prioritized gap list. Each gap can carry an anchor to the offending span
// so the reviewer can promote it into a draft thread (composing with the review
// pipeline). The default rubric is a deterministic set of heuristics over the
// Markdown text, so the feature works with NO AI endpoint and is fully unit-
// testable under `node --test`; an optional AI endpoint (mirroring the summarize
// and suggest patterns) can supply an enhanced assessment when configured. This
// module is intentionally free of DOM/React/Vite globals and never mutates its
// input.

import type { Anchor } from './types';
import type { ResolvedSkill } from './aiSkill';

export type ReadinessSeverity = 'critical' | 'important' | 'minor';

/** A single readiness gap. `anchor` (when present) lets the caller promote it to
 * a draft thread at the offending span. */
export interface ReadinessGap {
  /** Stable rubric check id (e.g. 'acceptanceCriteria'). */
  id: string;
  /** Short headline shown in the panel and used as a promoted comment's lead. */
  title: string;
  /** One-line explanation / suggested fix. */
  detail: string;
  severity: ReadinessSeverity;
  /** Optional anchor to the relevant span (absent for whole-doc / empty-doc gaps). */
  anchor?: Anchor;
  /** Optional concrete replacement/insertion for one-click remediation. */
  replacement?: string;
  /** Optional skill used to ground this gap. */
  skillName?: string;
}

/** A rubric check: a weighted, named test over the document text. */
export interface RubricCheck {
  id: string;
  /** Human label for the check. */
  label: string;
  severity: ReadinessSeverity;
  /** Relative weight in the score (higher = more important to readiness). */
  weight: number;
  /**
   * Evaluate the check. Return `null` when the check passes, or a partial gap
   * (title/detail/optional anchor) describing what's missing. `markdown` is the
   * raw document; `ctx` gives cheap precomputed views.
   */
  evaluate: (markdown: string, ctx: RubricContext) => Omit<ReadinessGap, 'id' | 'severity'> | null;
}

export type ReadinessRubric = readonly RubricCheck[];

export interface RubricContext {
  /** Lowercased full document (for keyword scans). */
  lower: string;
  /** The H1 title text (without leading `#`), or '' when absent. */
  title: string;
  /** Number of `##`+ section headings. */
  sectionCount: number;
  /** Non-whitespace character count. */
  length: number;
}

export type ReadinessLabel = 'ready' | 'needs-work' | 'not-ready';

export interface ReadinessAssessment {
  docTitle: string;
  /** 0–100 completeness score. */
  score: number;
  /** Letter grade derived from the score. */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  label: ReadinessLabel;
  /** Ordered (most severe first) list of gaps to address. */
  gaps: ReadinessGap[];
  /** Per-check pass/fail, in rubric order (for transparency). */
  checks: { id: string; label: string; severity: ReadinessSeverity; passed: boolean }[];
  /** True when there is essentially nothing to assess. */
  empty: boolean;
  /** Where the assessment came from. */
  source: 'local' | 'ai';
  /** Optional skill used to ground this assessment. */
  skillName?: string;
}

const CONTEXT = 32; // chars of prefix/suffix context stored on an anchor (matches anchor.ts)
const SEVERITY_RANK: Record<ReadinessSeverity, number> = { critical: 0, important: 1, minor: 2 };

/** Build an anchor for a span [start, start+length) inside a plain string. Mirrors
 * the quote+prefix+suffix model used by the anchor engine so the span can be
 * re-located after edits. */
export function spanAnchor(source: string, start: number, length: number): Anchor {
  const end = start + length;
  return {
    quote: source.slice(start, end),
    prefix: source.slice(Math.max(0, start - CONTEXT), start),
    suffix: source.slice(end, Math.min(source.length, end + CONTEXT)),
    start,
  };
}

/** Anchor to the document's H1 title text (without the `#`), else the first
 * non-empty line. Returns undefined for an empty document. */
function docAnchor(markdown: string): Anchor | undefined {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1) {
    const quote = h1[1].trim();
    const idx = markdown.indexOf(quote);
    if (idx !== -1) return spanAnchor(markdown, idx, quote.length);
  }
  const firstLine = markdown.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) {
    const stripped = firstLine.replace(/^[#>\-*\s]+/, '').trim() || firstLine;
    const idx = markdown.indexOf(stripped);
    if (idx !== -1) return spanAnchor(markdown, idx, stripped.length);
  }
  return undefined;
}

/** Find the first case-insensitive occurrence of any phrase and return an anchor
 * plus a count of total occurrences across all phrases. */
function findPhrase(
  markdown: string,
  phrases: readonly string[]
): { anchor?: Anchor; count: number; sample: string } {
  const lower = markdown.toLowerCase();
  let firstAt = -1;
  let firstLen = 0;
  let firstText = '';
  let count = 0;
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      count++;
      if (firstAt === -1 || at < firstAt) {
        firstAt = at;
        firstLen = phrase.length;
        firstText = markdown.slice(at, at + phrase.length);
      }
      from = at + needle.length;
      if (count > 200) break;
    }
  }
  return {
    anchor: firstAt === -1 ? undefined : spanAnchor(markdown, firstAt, firstLen),
    count,
    sample: firstText,
  };
}

function hasKeyword(lower: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => lower.includes(k));
}

const VAGUE_REWRITES: Record<string, string> = {
  fast: 'responsive within a defined latency budget (e.g. p95 < 200 ms)',
  scalable: 'able to scale to a defined target load (e.g. N concurrent users)',
  robust: 'resilient to defined failure modes',
  'user-friendly': 'usable per the documented usability criteria',
  'user friendly': 'usable per the documented usability criteria',
  seamless: 'integrated without manual steps',
  intuitive: 'usable per the documented usability criteria',
  performant: 'within a defined performance budget',
  'easy to use': 'usable per the documented usability criteria',
  'as needed': 'under the following conditions: <list them>',
  'etc.': '<complete the list explicitly>',
  'and so on': '<complete the list explicitly>',
};

function sectionInsertion(gapId: string): string | undefined {
  if (gapId === 'acceptanceCriteria') {
    return '## Acceptance criteria\n- [ ] <describe a testable outcome>\n- [ ] <describe another observable completion condition>';
  }
  if (gapId === 'requirements') {
    return '## Requirements\n- <describe the first required behavior>\n- <describe the next required behavior>';
  }
  if (gapId === 'nonGoals') {
    return '## Non-goals\n- <describe what is intentionally out of scope>';
  }
  if (gapId === 'successMetrics') {
    return '## Success metrics\n- <define the measurable target and how it will be observed>';
  }
  if (gapId === 'dependencies') {
    return '## Dependencies, assumptions, and risks\n- Dependency: <external system or team>\n- Assumption: <condition that must hold>\n- Risk: <known risk and mitigation>';
  }
  if (gapId === 'structure') {
    return '## Overview\n<describe the problem and goal>\n\n## Requirements\n- <describe the required behavior>';
  }
  return undefined;
}

function replacementForGap(markdown: string, gap: ReadinessGap): string | undefined {
  if (gap.id === 'noUnresolved') return '<specify the concrete value>';
  if (gap.id === 'measurableLanguage' && gap.anchor) {
    const rewrite = VAGUE_REWRITES[gap.anchor.quote.toLowerCase()];
    return rewrite || '<replace with a measurable requirement>';
  }
  if (gap.id === 'title') return '# <Feature or requirement name>';
  const insertion = sectionInsertion(gap.id);
  if (!insertion) return undefined;
  if (gap.anchor) return `${gap.anchor.quote}\n\n${insertion}`;
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n\n${insertion}` : insertion;
}

function withGapFixes(markdown: string, gaps: ReadinessGap[], skill?: ResolvedSkill | null): ReadinessGap[] {
  return gaps.map((gap) => ({
    ...gap,
    ...(gap.replacement ? {} : { replacement: replacementForGap(markdown, gap) }),
    ...(skill ? { skillName: skill.name } : {}),
  }));
}

// ---- The default AI Implementation Readiness rubric -------------------------
// Weights sum is used as the denominator; passing checks contribute their weight.

export const DEFAULT_RUBRIC: ReadinessRubric = [
  {
    id: 'title',
    label: 'Has a clear title',
    severity: 'minor',
    weight: 1,
    evaluate: (_md, ctx) =>
      ctx.title
        ? null
        : {
            title: 'Add a document title',
            detail: 'Start the document with a top-level `# Heading` naming the feature or spec.',
            anchor: docAnchor(_md),
          },
  },
  {
    id: 'overview',
    label: 'States the problem / overview',
    severity: 'important',
    weight: 1,
    evaluate: (_md, ctx) =>
      hasKeyword(ctx.lower, ['overview', 'summary', 'background', 'problem', 'context', 'motivation'])
        ? null
        : {
            title: 'Add an overview / problem statement',
            detail:
              'A coding agent needs the "why". Add an Overview, Problem, or Background section describing the goal.',
          },
  },
  {
    id: 'acceptanceCriteria',
    label: 'Defines acceptance criteria',
    severity: 'critical',
    weight: 3,
    evaluate: (md, ctx) => {
      const hasChecklist = /^\s*[-*]\s+\[[ xX]?\]/m.test(md);
      if (hasKeyword(ctx.lower, ['acceptance criteria', 'acceptance test', 'definition of done']) || hasChecklist) {
        return null;
      }
      return {
        title: 'Add acceptance criteria',
        detail:
          'Without testable acceptance criteria an agent cannot know when the work is done. Add an "Acceptance criteria" section or a `- [ ]` checklist.',
        anchor: docAnchor(md),
      };
    },
  },
  {
    id: 'requirements',
    label: 'Enumerates requirements / scope',
    severity: 'important',
    weight: 2,
    evaluate: (md, ctx) => {
      const hasList = /^\s*(?:[-*]\s+|\d+\.\s+)/m.test(md);
      if (
        hasKeyword(ctx.lower, ['requirement', 'user stor', 'scope', 'behavior', 'behaviour', 'functional']) ||
        hasList
      ) {
        return null;
      }
      return {
        title: 'Enumerate the requirements',
        detail:
          'List the concrete requirements, user stories, or in-scope behaviors so the work is bounded.',
        anchor: docAnchor(md),
      };
    },
  },
  {
    id: 'nonGoals',
    label: 'Declares non-goals / out of scope',
    severity: 'important',
    weight: 1,
    evaluate: (md, ctx) =>
      hasKeyword(ctx.lower, ['non-goal', 'non goal', 'nongoal', 'out of scope', 'out-of-scope', 'not in scope'])
        ? null
        : {
            title: 'Declare non-goals',
            detail:
              'State what is explicitly out of scope so the agent does not over-build or drift.',
            anchor: docAnchor(md),
          },
  },
  {
    id: 'successMetrics',
    label: 'Specifies success metrics',
    severity: 'important',
    weight: 1,
    evaluate: (md, ctx) =>
      hasKeyword(ctx.lower, ['success metric', 'success criteria', 'kpi', 'measur', 'metric', 'target', 'sla'])
        ? null
        : {
            title: 'Specify success metrics',
            detail: 'Add measurable targets (e.g. latency, adoption, error rate) that define success.',
            anchor: docAnchor(md),
          },
  },
  {
    id: 'noUnresolved',
    label: 'No unresolved placeholders',
    severity: 'important',
    weight: 2,
    evaluate: (md) => {
      const hit = findPhrase(md, ['TBD', 'TODO', 'FIXME', '???', 'to be determined', 'to be decided']);
      if (hit.count === 0) return null;
      return {
        title: `Resolve ${hit.count} unresolved placeholder${hit.count === 1 ? '' : 's'}`,
        detail: `Placeholders like "${hit.sample}" signal the spec is unfinished. Resolve them before handing the doc to an agent.`,
        anchor: hit.anchor,
      };
    },
  },
  {
    id: 'measurableLanguage',
    label: 'Avoids vague, unmeasurable language',
    severity: 'minor',
    weight: 1,
    evaluate: (md) => {
      const hit = findPhrase(md, [
        'fast',
        'scalable',
        'robust',
        'user-friendly',
        'user friendly',
        'seamless',
        'intuitive',
        'performant',
        'easy to use',
        'as needed',
        'etc.',
        'and so on',
      ]);
      if (hit.count === 0) return null;
      return {
        title: `Quantify ${hit.count} vague term${hit.count === 1 ? '' : 's'}`,
        detail: `Vague words like "${hit.sample}" are not implementable. Replace them with measurable requirements.`,
        anchor: hit.anchor,
      };
    },
  },
  {
    id: 'dependencies',
    label: 'Notes dependencies / assumptions / risks',
    severity: 'minor',
    weight: 1,
    evaluate: (md, ctx) =>
      hasKeyword(ctx.lower, ['dependenc', 'assumption', 'risk', 'constraint', 'prerequisite'])
        ? null
        : {
            title: 'Note dependencies, assumptions, and risks',
            detail: 'Call out external dependencies, assumptions, and known risks so the agent plans around them.',
            anchor: docAnchor(md),
          },
  },
  {
    id: 'structure',
    label: 'Uses clear section structure',
    severity: 'minor',
    weight: 1,
    evaluate: (md, ctx) =>
      ctx.sectionCount >= 2
        ? null
        : {
            title: 'Add section structure',
            detail: 'Break the document into `##` sections so requirements are easy to locate and reference.',
            anchor: docAnchor(md),
          },
  },
];

function buildContext(markdown: string): RubricContext {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  const sectionCount = (markdown.match(/^#{2,6}\s+\S/gm) || []).length;
  return {
    lower: markdown.toLowerCase(),
    title: h1 ? h1[1].trim() : '',
    sectionCount,
    length: markdown.replace(/\s+/g, '').length,
  };
}

function gradeFor(score: number): ReadinessAssessment['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function labelFor(score: number): ReadinessLabel {
  if (score >= 80) return 'ready';
  if (score >= 60) return 'needs-work';
  return 'not-ready';
}

/**
 * Assess the document against the rubric. Pure and read-only. An empty or near-
 * empty document returns a friendly, zero-score result flagged `empty` rather
 * than a wall of gaps.
 */
export function assessReadiness(
  markdown: string,
  docTitle: string,
  rubric: ReadinessRubric = DEFAULT_RUBRIC,
  skill?: ResolvedSkill | null
): ReadinessAssessment {
  const text = markdown || '';
  const ctx = buildContext(text);
  const empty = ctx.length < 20;
  const title = docTitle || ctx.title || 'Untitled document';

  if (empty) {
    return {
      docTitle: title,
      score: 0,
      grade: 'F',
      label: 'not-ready',
      gaps: withGapFixes(text, [
        {
          id: 'empty',
          title: 'Document is empty',
          detail: 'There is nothing to assess yet. Add the spec content, then re-run the readiness check.',
          severity: 'critical',
        },
      ], skill),
      checks: rubric.map((c) => ({ id: c.id, label: c.label, severity: c.severity, passed: false })),
      empty: true,
      source: 'local',
      ...(skill ? { skillName: skill.name } : {}),
    };
  }

  const gaps: ReadinessGap[] = [];
  const checks: ReadinessAssessment['checks'] = [];
  let earned = 0;
  let total = 0;
  for (const check of rubric) {
    total += check.weight;
    const result = check.evaluate(text, ctx);
    const passed = result === null;
    if (passed) {
      earned += check.weight;
    } else {
      gaps.push({ id: check.id, severity: check.severity, ...result });
    }
    checks.push({ id: check.id, label: check.label, severity: check.severity, passed });
  }

  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  gaps.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    docTitle: title,
    score,
    grade: gradeFor(score),
    label: labelFor(score),
    gaps: withGapFixes(text, gaps, skill),
    checks,
    empty: false,
    source: 'local',
    ...(skill ? { skillName: skill.name } : {}),
  };
}

const GRADE_SUMMARY: Record<ReadinessAssessment['grade'], string> = {
  A: 'Ready for a coding agent.',
  B: 'Mostly ready — a few gaps to close.',
  C: 'Needs work before handing to an agent.',
  D: 'Significant gaps remain.',
  F: 'Not ready — key sections are missing.',
};

/** Deterministic plain-text rendering — used for copy and as a compact summary. */
export function renderReadinessText(assessment: ReadinessAssessment): string {
  const header =
    `AI-readiness of "${assessment.docTitle}": ${assessment.score}/100 (grade ${assessment.grade})\n` +
    GRADE_SUMMARY[assessment.grade];
  if (assessment.gaps.length === 0) {
    return `${header}\n\nNo gaps found — every rubric check passed.`;
  }
  const lines = assessment.gaps.map((gap, i) => `${i + 1}. [${gap.severity}] ${gap.title} — ${gap.detail}`);
  return `${header}\n\nGaps (${assessment.gaps.length}):\n${lines.join('\n')}`;
}

// ---- Optional AI endpoint ---------------------------------------------------

/** Read-only payload sent to an AI readiness endpoint. Only the document text and
 * a title — no identity secrets or provider tokens. */
export function buildReadinessPayload(markdown: string, docTitle: string, skill?: ResolvedSkill | null) {
  return { docTitle: docTitle || 'Untitled document', markdown: markdown || '', ...(skill ? { skill } : {}) };
}

function normalizeSeverity(value: unknown): ReadinessSeverity {
  return value === 'critical' || value === 'important' || value === 'minor' ? value : 'important';
}

/**
 * Request an AI readiness assessment. Never throws: a missing endpoint, network
 * error, or malformed response resolves to { ok: false, reason } so the caller can
 * fall back to the deterministic local assessment. When the AI returns gaps it may
 * include an optional `quote`; if that quote is found in the document we anchor the
 * gap so it can still be promoted to a thread.
 */
export async function requestAiReadiness(
  endpoint: string,
  markdown: string,
  docTitle: string,
  skillOrFetch?: ResolvedSkill | null | typeof fetch,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; assessment: ReadinessAssessment } | { ok: false; reason: string }> {
  if (!endpoint) return { ok: false, reason: 'no endpoint configured' };
  const skill = typeof skillOrFetch === 'function' ? null : skillOrFetch;
  const fetcher = typeof skillOrFetch === 'function' ? skillOrFetch : fetchImpl;
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReadinessPayload(markdown, docTitle, skill)),
    });
    if (!response.ok) return { ok: false, reason: `endpoint returned ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as {
      score?: unknown;
      grade?: unknown;
      gaps?: unknown;
    };
    const rawScore = typeof data.score === 'number' ? data.score : NaN;
    if (!Number.isFinite(rawScore)) return { ok: false, reason: 'endpoint returned no score' };
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const gapsIn = Array.isArray(data.gaps) ? data.gaps : [];
    const gaps: ReadinessGap[] = gapsIn.slice(0, 50).map((raw: any, i: number) => {
      const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : `Gap ${i + 1}`;
      const detail = typeof raw?.detail === 'string' ? raw.detail.trim() : '';
      const severity = normalizeSeverity(raw?.severity);
      let anchor: Anchor | undefined;
      if (typeof raw?.quote === 'string' && raw.quote.trim()) {
        const idx = markdown.indexOf(raw.quote);
        if (idx !== -1) anchor = spanAnchor(markdown, idx, raw.quote.length);
      }
      return {
        id: `ai-${i}`,
        title,
        detail,
        severity,
        ...(anchor ? { anchor } : {}),
        ...(typeof raw?.replacement === 'string' && raw.replacement ? { replacement: raw.replacement } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      };
    });
    gaps.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const grade =
      data.grade === 'A' || data.grade === 'B' || data.grade === 'C' || data.grade === 'D' || data.grade === 'F'
        ? data.grade
        : gradeFor(score);
    return {
      ok: true,
      assessment: {
        docTitle: docTitle || 'Untitled document',
        score,
        grade,
        label: labelFor(score),
        gaps: withGapFixes(markdown, gaps, skill),
        checks: [],
        empty: false,
        source: 'ai',
        ...(skill ? { skillName: skill.name } : {}),
      },
    };
  } catch (error: any) {
    return { ok: false, reason: error?.message || String(error) };
  }
}
