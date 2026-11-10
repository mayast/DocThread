// AI-suggested edits (#63).
//
// Turns free-text review feedback on an anchored span into a concrete, apply-ready
// replacement by asking a configured AI endpoint for a rewrite. The result feeds
// the existing #35 suggestion UI (before/after diff + Apply), so there's no
// divergent write path. Kept dependency-free (the endpoint + fetch are injected)
// so it's unit-testable under `node --test`; when no endpoint is configured the
// caller degrades gracefully with a clear note (no crash, no repo write).

import type { Comment } from './types.ts';
import type { ResolvedSkill } from './aiSkill.ts';

/** The read-only payload sent to the AI endpoint to draft a replacement. */
export interface AiSuggestionRequest {
  /** The exact anchored text the reviewer highlighted (the "before"). */
  original: string;
  /** The reviewer feedback (comment bodies) describing the desired change. */
  feedback: string[];
  /** Optional short document title for context. */
  docTitle?: string;
  /** Optional org/team skill that constrains the rewrite style and standards. */
  skill?: ResolvedSkill;
}

export type AiSuggestionResult =
  | { ok: true; replacement: string }
  | { ok: false; reason: string };

/**
 * Build the AI request from a thread's anchored text and its comments. Only the
 * anchored span and the human-authored comment bodies are included — no identity
 * secrets, tokens, or resolver addresses.
 */
export function buildSuggestionRequest(
  original: string,
  comments: readonly Comment[],
  docTitle?: string,
  skill?: ResolvedSkill | null
): AiSuggestionRequest {
  const feedback = comments
    .map((comment) => comment.body.trim())
    .filter((body) => body.length > 0);
  return { original, feedback, ...(docTitle ? { docTitle } : {}), ...(skill ? { skill } : {}) };
}

/**
 * Request an AI-drafted replacement for the anchored text. Never throws — a
 * missing endpoint, network error, or malformed response is reported in the
 * result so the caller can surface a note without breaking the review flow.
 * A replacement identical to the original is treated as "no change".
 */
export async function requestAiSuggestion(
  endpoint: string,
  request: AiSuggestionRequest,
  fetchImpl: typeof fetch = fetch
): Promise<AiSuggestionResult> {
  if (!endpoint) {
    return { ok: false, reason: 'no endpoint configured' };
  }
  if (request.feedback.length === 0) {
    return { ok: false, reason: 'no feedback to act on' };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      return { ok: false, reason: `endpoint returned ${response.status}` };
    }
    const data = (await response.json().catch(() => ({}))) as {
      replacement?: unknown;
      text?: unknown;
    };
    const replacement =
      typeof data.replacement === 'string'
        ? data.replacement
        : typeof data.text === 'string'
          ? data.text
          : null;
    if (replacement === null) {
      return { ok: false, reason: 'endpoint returned no replacement' };
    }
    if (replacement === request.original) {
      return { ok: false, reason: 'the AI proposed no change' };
    }
    return { ok: true, replacement };
  } catch (error: any) {
    return { ok: false, reason: error?.message || String(error) };
  }
}
