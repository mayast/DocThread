// Review-policy artifact — REVIEW.md (#89).
//
// Parses an optional, version-controlled REVIEW.md into a policy that governs the
// AI reviewer pass (#43): which passes to run (bugs / security / compliance /
// custom), the Important-vs-Nit split, a nit cap, and a do-not-report exclude
// list. Applying the policy to a set of findings tags/ranks them by severity and
// collapses nits beyond the cap. Pure and DOM-free so it is unit-testable under
// `node --test`; when no REVIEW.md exists the caller uses DEFAULT_POLICY, so the
// reviewer keeps working with zero configuration.

import type { Anchor } from './types';

export type ReviewSeverity = 'important' | 'nit';

export interface ReviewPass {
  /** Stable slug (e.g. 'bugs', 'security', 'compliance', or a custom slug). */
  id: string;
  label: string;
  description: string;
}

export interface ReviewPolicy {
  passes: ReviewPass[];
  /** What counts as Important (shown to the AI and in the UI). */
  importantDef: string;
  /** What counts as a Nit. */
  nitDef: string;
  /** Maximum nits surfaced; the rest are collapsed to a count. */
  nitCap: number;
  /** Case-insensitive tokens; a finding whose anchored context contains one is dropped. */
  exclude: string[];
  /** Where the policy came from. */
  source: 'REVIEW.md' | 'default';
}

/** A minimal shape the policy filter needs — the reviewer's ReviewFinding satisfies it. */
export interface PolicyFinding {
  severity: ReviewSeverity;
  anchor: Anchor;
}

export const DEFAULT_PASSES: ReviewPass[] = [
  { id: 'bugs', label: 'Bugs & logic', description: 'Logic errors, contradictions, broken edge cases' },
  { id: 'security', label: 'Security', description: 'Secrets in text, injection risks, auth gaps' },
  {
    id: 'compliance',
    label: 'Compliance',
    description: 'Ambiguity, missing or unmeasurable acceptance criteria, undefined terms',
  },
];

export const DEFAULT_POLICY: ReviewPolicy = {
  passes: DEFAULT_PASSES,
  importantDef: 'Findings that would break behavior, leak data, or block implementation.',
  nitDef: 'Style, wording, and minor clarity suggestions.',
  nitCap: 5,
  exclude: [],
  source: 'default',
};

const DEFAULT_NIT_CAP = 5;

/** Split a Markdown doc into `## Section` blocks keyed by lowercased heading text. */
function sectionMap(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = markdown.split('\n');
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (heading !== null) map.set(heading, buf.join('\n').trim());
  };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) {
      flush();
      heading = m[1].toLowerCase().trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return map;
}

/** Read bullet list items ("- item" / "* item") from a section body. */
function bulletItems(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((v): v is string => Boolean(v));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
}

/** Find the first section whose heading includes any of the given keywords. */
function findSection(map: Map<string, string>, keywords: string[]): string | undefined {
  for (const [heading, body] of map) {
    if (keywords.some((k) => heading.includes(k))) return body;
  }
  return undefined;
}

/**
 * Parse a REVIEW.md document into a ReviewPolicy. Every section is optional; a
 * missing or unparseable section falls back to the default. Never throws.
 */
export function parseReviewPolicy(markdown: string): ReviewPolicy {
  const text = markdown || '';
  if (!text.trim()) return DEFAULT_POLICY;
  const sections = sectionMap(text);

  // Passes — from a "Passes" section's bullet list ("- Bugs: logic errors").
  let passes: ReviewPass[] = [];
  const passesBody = findSection(sections, ['pass']);
  if (passesBody) {
    for (const item of bulletItems(passesBody)) {
      const [head, ...rest] = item.split(':');
      const label = head.replace(/\*\*/g, '').trim();
      if (!label) continue;
      passes.push({ id: slug(label.split(/\s|&/)[0]), label, description: rest.join(':').trim() });
    }
  }
  if (passes.length === 0) passes = DEFAULT_PASSES;

  // Important / Nit definitions.
  const importantDef = (findSection(sections, ['important']) || DEFAULT_POLICY.importantDef).trim();
  const nitDef = (findSection(sections, ['nit', 'cap the nit']) || DEFAULT_POLICY.nitDef).trim();

  // Nit cap — first integer in a "cap"/"nit" section, else scan whole doc for
  // "at most N nits", else default.
  let nitCap = DEFAULT_NIT_CAP;
  const capBody = findSection(sections, ['cap']) || '';
  const capMatch =
    capBody.match(/\b(\d{1,3})\b/) || text.match(/at most\s+(\d{1,3})\s+nits?/i);
  if (capMatch) {
    const n = parseInt(capMatch[1], 10);
    if (Number.isFinite(n) && n >= 0) nitCap = n;
  }

  // Exclusions — bullet list under a "Do not report" / "Exclude" section.
  const excludeBody = findSection(sections, ['do not report', 'exclude', 'skip', 'ignore']);
  const exclude = excludeBody ? bulletItems(excludeBody).map((s) => s.replace(/\*\*/g, '').trim()) : [];

  return { passes, importantDef, nitDef, nitCap, exclude, source: 'REVIEW.md' };
}

/** The set of enabled pass ids for quick membership checks. */
export function enabledPassIds(policy: ReviewPolicy): Set<string> {
  return new Set(policy.passes.map((p) => p.id));
}

/**
 * Apply the policy's severity ranking, exclusions, and nit cap to a list of
 * findings. Important findings sort ahead of nits; within a severity the input
 * (document) order is preserved. Excluded findings (whose anchored context
 * contains an exclude token) are dropped. Nits beyond the cap are removed from
 * `shown` and reported as `hiddenNits`.
 */
export function applyPolicy<T extends PolicyFinding>(
  findings: readonly T[],
  policy: ReviewPolicy
): { shown: T[]; hiddenNits: number } {
  const excl = policy.exclude.map((e) => e.toLowerCase()).filter(Boolean);
  const kept = findings.filter((f) => {
    if (excl.length === 0) return true;
    const ctx = `${f.anchor.prefix}${f.anchor.quote}${f.anchor.suffix}`.toLowerCase();
    return !excl.some((token) => ctx.includes(token));
  });

  const important = kept.filter((f) => f.severity === 'important');
  const nits = kept.filter((f) => f.severity === 'nit');
  const cappedNits = nits.slice(0, Math.max(0, policy.nitCap));
  const hiddenNits = nits.length - cappedNits.length;

  return { shown: [...important, ...cappedNits], hiddenNits };
}
