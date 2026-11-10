// Suggested-edits core (#35).
//
// A "suggestion" is an exact proposed replacement for a thread's anchored text.
// Applying it re-locates the anchor in the *current* document and swaps the span
// for the replacement — reusing the same anchoring engine (locateInText) the rest
// of the app uses, so a suggestion still applies after edits above/around it, and
// is reported stale when the span can no longer be found. Pure + dependency-light
// (only the anchor locator) so it's unit-testable under `node --test`.

import { locateInText } from './anchor.ts';
import type { Anchor } from './types.ts';

export type ApplySuggestionResult =
  | { ok: true; text: string; start: number; end: number; confidence: string }
  | { ok: false; reason: 'stale' };

/**
 * Produce the document text with the anchored span replaced by `replacement`.
 * Returns `{ ok: false, reason: 'stale' }` when the anchor can no longer be
 * located (the surrounding text changed too much) so the caller can flag the
 * suggestion instead of corrupting the document.
 */
export function applySuggestion(
  text: string,
  anchor: Anchor,
  replacement: string
): ApplySuggestionResult {
  const located = locateInText(text, anchor);
  if (!located || located.end < located.start) return { ok: false, reason: 'stale' };
  const next = text.slice(0, located.start) + replacement + text.slice(located.end);
  return {
    ok: true,
    text: next,
    start: located.start,
    end: located.start + replacement.length,
    confidence: located.confidence,
  };
}

/** True when a suggestion has already been applied to the document. */
export function isSuggestionApplied(suggestion: { appliedAt?: string } | undefined): boolean {
  return Boolean(suggestion?.appliedAt);
}

export interface DiffLine {
  kind: 'context' | 'removed' | 'added';
  text: string;
}

/**
 * A minimal line-oriented before/after diff for rendering a suggestion. This is a
 * display helper (not a merge): it emits the removed original lines followed by
 * the added replacement lines, with any shared leading/trailing lines as context.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: 'context', text: beforeLines[i] });
  for (let i = head; i < beforeLines.length - tail; i++) {
    out.push({ kind: 'removed', text: beforeLines[i] });
  }
  for (let i = head; i < afterLines.length - tail; i++) {
    out.push({ kind: 'added', text: afterLines[i] });
  }
  for (let i = beforeLines.length - tail; i < beforeLines.length; i++) {
    out.push({ kind: 'context', text: beforeLines[i] });
  }
  return out;
}
