import type { Thread } from './types';
import { deriveWaitingOn, extractMentions, threadIntent } from './review.ts';

// AI-assisted (with a deterministic local fallback) review digest. This module is
// intentionally free of DOM/React and Vite-only globals so the digest logic and
// the AI payload builder stay unit-testable under `node --test`. The optional AI
// call is a thin, never-throwing wrapper with an injected endpoint (mirroring the
// notifyEmail pattern), so the feature degrades gracefully when no endpoint is set.

export type SummaryScope = 'open' | 'all';

export interface DigestItem {
  /** Short one-line headline derived from the opening comment. */
  headline: string;
  author: string;
  replies: number;
  waitingOn: string[];
  mentions: string[];
  resolved: boolean;
}

export interface ReviewDigest {
  docTitle: string;
  scope: SummaryScope;
  totals: { threads: number; open: number; blocking: number; resolved: number };
  blockers: DigestItem[];
  questions: DigestItem[];
  suggestions: DigestItem[];
  decisions: DigestItem[];
}

const MAX_HEADLINE = 140;

function firstLine(body: string): string {
  const trimmed = (body || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_HEADLINE) return trimmed;
  return trimmed.slice(0, MAX_HEADLINE - 1).trimEnd() + '\u2026';
}

function toItem(thread: Thread): DigestItem {
  const first = thread.comments[0];
  const mentionSet = new Set<string>();
  for (const comment of thread.comments) {
    for (const handle of extractMentions(comment.body)) mentionSet.add(handle);
  }
  return {
    headline: firstLine(first?.body ?? '(no comment)'),
    author: first?.author ?? 'Unknown',
    replies: Math.max(0, thread.comments.length - 1),
    waitingOn: deriveWaitingOn(thread),
    mentions: [...mentionSet],
    resolved: Boolean(thread.resolved),
  };
}

/**
 * Build a grouped, read-only digest of the review. `scope` honors the panel's
 * current filter: `open` covers only unresolved threads; `all` also surfaces
 * resolved threads under Decisions. Pure — never mutates its input.
 */
export function buildReviewDigest(
  threads: readonly Thread[],
  scope: SummaryScope,
  docTitle: string
): ReviewDigest {
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const openByIntent = (intent: 'question' | 'suggestion' | 'blocking') =>
    open.filter((thread) => threadIntent(thread) === intent).map(toItem);

  return {
    docTitle: docTitle || 'Untitled document',
    scope,
    totals: {
      threads: threads.length,
      open: open.length,
      blocking: open.filter((thread) => threadIntent(thread) === 'blocking').length,
      resolved: resolved.length,
    },
    blockers: openByIntent('blocking'),
    questions: openByIntent('question'),
    suggestions: openByIntent('suggestion'),
    decisions: scope === 'all' ? resolved.map(toItem) : [],
  };
}

function renderGroup(title: string, items: DigestItem[]): string[] {
  if (items.length === 0) return [];
  const lines = [`${title} (${items.length})`];
  for (const item of items) {
    const suffixParts: string[] = [];
    if (item.waitingOn.length) suffixParts.push(`waiting on ${item.waitingOn.map((h) => '@' + h).join(', ')}`);
    if (item.replies) suffixParts.push(`${item.replies} repl${item.replies === 1 ? 'y' : 'ies'}`);
    const suffix = suffixParts.length ? `  — ${suffixParts.join('; ')}` : '';
    lines.push(`  • ${item.headline} (${item.author})${suffix}`);
  }
  return lines;
}

/** Deterministic plain-text rendering of a digest — used for display and copy,
 * and as the graceful fallback when no AI endpoint is configured. */
export function renderDigestText(digest: ReviewDigest): string {
  const scopeLabel = digest.scope === 'all' ? 'all threads' : 'open threads';
  if (digest.totals.threads === 0) {
    return `Review of "${digest.docTitle}"\n\nNo review threads yet — highlight text in the document to start one.`;
  }
  const header =
    `Review of "${digest.docTitle}" — ${scopeLabel}\n` +
    `${digest.totals.open} open · ${digest.totals.blocking} blocking · ${digest.totals.resolved} resolved`;
  const sections = [
    ...renderGroup('Blockers', digest.blockers),
    ...renderGroup('Open questions', digest.questions),
    ...renderGroup('Suggestions', digest.suggestions),
    ...renderGroup('Decisions & resolved', digest.decisions),
  ];
  const body =
    sections.length > 0
      ? sections.join('\n')
      : digest.scope === 'open'
      ? 'No open threads. Everything is resolved — switch the filter to All to review decisions.'
      : 'No threads to summarize.';
  return `${header}\n\n${body}`;
}

// ---- Optional AI endpoint ---------------------------------------------------

/** Structured, read-only payload sent to an AI summarization endpoint. Contains
 * only what the panel already shows (bodies, intents, resolved, mentions) — no
 * identity secrets or provider tokens. */
export function buildAiSummaryPayload(
  threads: readonly Thread[],
  scope: SummaryScope,
  docTitle: string
) {
  const included = scope === 'all' ? threads : threads.filter((thread) => !thread.resolved);
  return {
    docTitle: docTitle || 'Untitled document',
    scope,
    threads: included.map((thread) => ({
      intent: threadIntent(thread),
      resolved: Boolean(thread.resolved),
      waitingOn: deriveWaitingOn(thread),
      comments: thread.comments.map((comment) => ({
        author: comment.author,
        body: comment.body,
        mentions: extractMentions(comment.body),
      })),
    })),
  };
}

export interface AiSummaryResult {
  text: string | null;
  reason?: string;
}

/**
 * POST the digest payload to an AI summarization endpoint and return its text.
 * Never throws: any failure resolves to { text: null, reason } so the caller can
 * fall back to the deterministic local digest without breaking the review flow.
 */
export async function requestAiSummary(
  endpoint: string,
  payload: ReturnType<typeof buildAiSummaryPayload>,
  fetchImpl: typeof fetch = fetch
): Promise<AiSummaryResult> {
  if (!endpoint) return { text: null, reason: 'no endpoint configured' };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { text: null, reason: `endpoint returned ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as { summary?: unknown; text?: unknown };
    const text = typeof data.summary === 'string' ? data.summary : typeof data.text === 'string' ? data.text : '';
    return text.trim() ? { text: text.trim() } : { text: null, reason: 'empty summary' };
  } catch (error: any) {
    return { text: null, reason: error?.message || String(error) };
  }
}
