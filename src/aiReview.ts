// AI reviewer pass (#43), governed by a REVIEW.md policy (#89).
//
// Reads the current document and produces text-anchored DRAFT findings — ambiguity,
// unresolved placeholders, unmeasurable language, plaintext secrets — each with an
// intent, a severity, a pass (from the policy), and a rationale. A deterministic
// local pass runs with no configuration (so the feature is live by default); an
// optional AI endpoint returns richer findings when configured. Findings are never
// persisted or notified by the pass itself — a human Accepts a finding to promote it
// to a real thread, or Dismisses it. Pure and DOM-free for `node --test`.

import type { Anchor, ThreadIntent } from './types';
import { spanAnchor } from './readiness.ts';
import { applyPolicy, enabledPassIds, type ReviewPolicy, type ReviewSeverity } from './reviewPolicy.ts';
import type { ResolvedSkill } from './aiSkill.ts';

export interface ReviewFinding {
  id: string;
  anchor: Anchor;
  /** Maps to the thread intent when accepted. */
  intent: ThreadIntent;
  severity: ReviewSeverity;
  /** Policy pass id this finding belongs to (e.g. 'compliance'). */
  pass: string;
  title: string;
  rationale: string;
  /** Optional proposed replacement — composes with Suggested edits (#35). */
  replacement?: string;
  /** Optional skill used to ground the finding. */
  skillName?: string;
  origin: 'ai' | 'local';
}

interface Detector {
  pass: string;
  severity: ReviewSeverity;
  intent: ThreadIntent;
  title: string;
  rationale: string;
  /** Case-insensitive phrases to flag. */
  phrases: string[];
  /**
   * Optional deterministic rewrite for the matched term (#108). It returns a
   * concrete phrase that is *grammatically substituted for the flagged term inside
   * its containing sentence*, so the proposed replacement reads as a natural,
   * directly-usable sentence (a real A → B change) rather than an instruction about
   * the change. Omitted where an automated rewrite is unsafe (e.g. secrets), which
   * surface as manual-review.
   */
  rewrite?: (matched: string) => string;
}

// Concrete, measurable stand-ins for vague adjectives. Each is written to slot in
// grammatically where the vague word was ("must be fast" → "must be responsive
// within a defined latency budget (e.g. p95 < 200 ms)").
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
};

// Explicit stand-ins for ambiguous scope phrases.
const AMBIGUOUS_REWRITES: Record<string, string> = {
  'as needed': 'under the following conditions: <list them>',
  'if necessary': 'under the following conditions: <list them>',
  'as appropriate': 'under the following conditions: <list them>',
  'etc.': '<complete the list explicitly>',
  'and so on': '<complete the list explicitly>',
  'and/or': 'or <state whether both are allowed>',
};

// Deterministic local detectors. Each occurrence of a phrase becomes one finding,
// anchored to its containing sentence so the proposed replacement is a full,
// readable sentence. Passes gate which detectors run.
const DETECTORS: Detector[] = [
  {
    pass: 'compliance',
    severity: 'important',
    intent: 'blocking',
    title: 'Unresolved placeholder',
    rationale: 'A placeholder signals the spec is unfinished. Resolve it before handing the doc to a coding agent.',
    phrases: ['TBD', 'TODO', 'FIXME', '???', 'to be determined', 'to be decided'],
    // A placeholder needs a human decision; substitute a clear, in-sentence slot.
    rewrite: () => '<specify the concrete value>',
  },
  {
    pass: 'compliance',
    severity: 'nit',
    intent: 'suggestion',
    title: 'Vague, unmeasurable term',
    rationale: 'This word is not implementable as written. Replace it with a measurable requirement.',
    phrases: [
      'fast',
      'scalable',
      'robust',
      'user-friendly',
      'user friendly',
      'seamless',
      'intuitive',
      'performant',
      'easy to use',
    ],
    rewrite: (matched) =>
      VAGUE_REWRITES[matched.toLowerCase()] ?? 'defined by a measurable requirement',
  },
  {
    pass: 'compliance',
    severity: 'nit',
    intent: 'question',
    title: 'Ambiguous scope',
    rationale: 'This phrasing leaves the scope open to interpretation. Make it explicit.',
    phrases: ['as needed', 'if necessary', 'etc.', 'and so on', 'as appropriate', 'and/or'],
    rewrite: (matched) =>
      AMBIGUOUS_REWRITES[matched.toLowerCase()] ?? '<specify the exact condition or list>',
  },
  {
    pass: 'security',
    severity: 'important',
    intent: 'blocking',
    title: 'Possible secret in the document',
    rationale: 'Specs should not embed credentials, and should state how secrets are stored and accessed. Confirm nothing sensitive is inlined.',
    phrases: ['password', 'api key', 'apikey', 'secret key', 'private key', 'client secret', 'access token'],
    // No `rewrite`: proposing an automated rewrite of a possible secret is unsafe;
    // this finding is surfaced for manual review instead.
  },
];

/**
 * Return the [start, end) span of the sentence containing the match at `at`. A
 * sentence is bounded by `.`/`!`/`?` or a newline. This lets a finding anchor to
 * the whole sentence so its proposed replacement reads as a complete, natural
 * sentence (a real A → B change) instead of a mid-sentence fragment.
 */
function sentenceSpan(text: string, at: number, len: number): { start: number; end: number } {
  const isBoundary = (ch: string) => ch === '.' || ch === '!' || ch === '?' || ch === '\n';
  let start = at;
  while (start > 0 && !isBoundary(text[start - 1])) start -= 1;
  // Skip leading whitespace so the anchor begins at the first word.
  while (start < at && /\s/.test(text[start])) start += 1;
  let end = at + len;
  while (end < text.length && !isBoundary(text[end])) end += 1;
  // Include the terminating punctuation (but not a trailing newline) in the span.
  if (end < text.length && text[end] !== '\n') end += 1;
  return { start, end };
}

/** Find every case-insensitive occurrence of a phrase, capped for safety. */
function findAll(markdown: string, phrase: string): number[] {
  const lower = markdown.toLowerCase();
  const needle = phrase.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    from = at + needle.length;
    if (out.length > 100) break;
  }
  return out;
}

/**
 * Deterministic local review pass. Emits raw (uncapped, unexcluded) findings for
 * the passes enabled by the policy; the caller applies the policy to rank/cap.
 */
export function localReviewPass(markdown: string, policy: ReviewPolicy): ReviewFinding[] {
  const text = markdown || '';
  const enabled = enabledPassIds(policy);
  const findings: ReviewFinding[] = [];
  let seq = 0;
  for (const detector of DETECTORS) {
    if (!enabled.has(detector.pass)) continue;
    for (const phrase of detector.phrases) {
      for (const at of findAll(text, phrase)) {
        const matched = text.slice(at, at + phrase.length);
        if (detector.rewrite) {
          // Anchor to the containing sentence and propose the whole sentence with
          // the flagged term rewritten in place, so the before/after is a natural,
          // directly-usable A → B change (#108).
          const span = sentenceSpan(text, at, matched.length);
          const sentence = text.slice(span.start, span.end);
          const localAt = at - span.start;
          const replacement =
            sentence.slice(0, localAt) + detector.rewrite(matched) + sentence.slice(localAt + matched.length);
          findings.push({
            id: `local-${seq++}`,
            anchor: spanAnchor(text, span.start, sentence.length),
            intent: detector.intent,
            severity: detector.severity,
            pass: detector.pass,
            title: detector.title,
            rationale: detector.rationale,
            replacement,
            origin: 'local',
          });
        } else {
          // No safe automated rewrite (e.g. secrets): flag the term for manual review.
          findings.push({
            id: `local-${seq++}`,
            anchor: spanAnchor(text, at, matched.length),
            intent: detector.intent,
            severity: detector.severity,
            pass: detector.pass,
            title: detector.title,
            rationale: detector.rationale,
            origin: 'local',
          });
        }
      }
    }
  }
  // Stable document order so the policy's severity ranking is deterministic.
  findings.sort((a, b) => a.anchor.start - b.anchor.start);
  return findings;
}

// ---- Optional AI endpoint ---------------------------------------------------

/** Read-only payload sent to an AI review endpoint: the document plus the policy
 * that should govern the pass. No identity secrets or provider tokens. */
export function buildReviewPayload(
  markdown: string,
  docTitle: string,
  policy: ReviewPolicy,
  skill?: ResolvedSkill | null
) {
  return {
    docTitle: docTitle || 'Untitled document',
    markdown: markdown || '',
    policy: {
      passes: policy.passes.map((p) => ({ id: p.id, label: p.label, description: p.description })),
      important: policy.importantDef,
      nit: policy.nitDef,
      nitCap: policy.nitCap,
      exclude: policy.exclude,
    },
    ...(skill ? { skill } : {}),
  };
}

const INTENTS = new Set<ThreadIntent>(['question', 'suggestion', 'blocking']);

function normalizeIntent(value: unknown): ThreadIntent {
  return typeof value === 'string' && INTENTS.has(value as ThreadIntent) ? (value as ThreadIntent) : 'question';
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  return value === 'important' ? 'important' : 'nit';
}

/**
 * Request an AI review. Never throws. Each returned finding must include a `quote`
 * that appears in the document so it can be anchored; findings whose quote is not
 * found are skipped. Returns raw findings (policy ranking/cap is applied by the
 * caller). A missing endpoint or any error resolves to { ok: false, reason }.
 */
export async function requestAiReview(
  endpoint: string,
  markdown: string,
  docTitle: string,
  policy: ReviewPolicy,
  skillOrFetch?: ResolvedSkill | null | typeof fetch,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; findings: ReviewFinding[] } | { ok: false; reason: string }> {
  if (!endpoint) return { ok: false, reason: 'no endpoint configured' };
  const skill = typeof skillOrFetch === 'function' ? null : skillOrFetch;
  const fetcher = typeof skillOrFetch === 'function' ? skillOrFetch : fetchImpl;
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReviewPayload(markdown, docTitle, policy, skill)),
    });
    if (!response.ok) return { ok: false, reason: `endpoint returned ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as { findings?: unknown };
    const raw = Array.isArray(data.findings) ? data.findings : [];
    const findings: ReviewFinding[] = [];
    let seq = 0;
    for (const item of raw.slice(0, 100) as any[]) {
      const quote = typeof item?.quote === 'string' ? item.quote : '';
      if (!quote) continue;
      const idx = markdown.indexOf(quote);
      if (idx === -1) continue; // unanchorable → skip (findings must anchor to a span)
      findings.push({
        id: `ai-${seq++}`,
        anchor: spanAnchor(markdown, idx, quote.length),
        intent: normalizeIntent(item?.intent),
        severity: normalizeSeverity(item?.severity),
        pass: typeof item?.pass === 'string' && item.pass.trim() ? item.pass.trim() : 'compliance',
        title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : 'Review finding',
        rationale: typeof item?.rationale === 'string' ? item.rationale.trim() : '',
        ...(typeof item?.replacement === 'string' && item.replacement ? { replacement: item.replacement } : {}),
        ...(skill ? { skillName: skill.name } : {}),
        origin: 'ai',
      });
    }
    return { ok: true, findings };
  } catch (error: any) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

/** Convenience: run local + policy in one call (used when no endpoint is set). */
export function runLocalReview(
  markdown: string,
  policy: ReviewPolicy
): { shown: ReviewFinding[]; hiddenNits: number } {
  return applyPolicy(localReviewPass(markdown, policy), policy);
}
