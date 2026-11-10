import type { Comment, MentionReference, Thread, ThreadIntent } from './types';

export type ReviewFilter =
  | 'open'
  | 'question'
  | 'suggestion'
  | 'blocking'
  | 'mine'
  | 'needs-reanchor'
  | 'all';

export interface ReviewSummary {
  open: number;
  question: number;
  suggestion: number;
  blocking: number;
  waitingOnViewer: number;
}

// GitHub usernames are 1-39 chars. EMU logins may also contain an underscore.
const MENTION_RE = /(^|[^a-z\d_.@-])@([a-z\d](?:[a-z\d_]|-(?=[a-z\d_])){0,38})(?![a-z\d_-])/gi;

export function normalizeIdentity(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

/** Pull distinct @usernames out of a comment body. */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(body)) !== null) {
    const normalized = normalizeIdentity(match[2]);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    mentions.push(match[2]);
  }
  return mentions;
}

/** Legacy threads without an intent remain low-stakes questions. */
export function threadIntent(thread: Thread): ThreadIntent {
  return thread.intent ?? 'question';
}

/**
 * Ownership follows the latest comment that assigns someone with an @mention.
 * Anyone in that assignment who authored a later reply is no longer waiting.
 */
export interface WaitingOnIdentity {
  handle: string;
  identityKeys: string[];
}

function keyIntersects(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((key) => right.has(key));
}

function structuredAssignments(comment: Comment): WaitingOnIdentity[] | null {
  if (comment.identityVersion !== 1 || !comment.mentions) return null;
  return comment.mentions.map((mention: MentionReference) => ({
    handle: mention.handle,
    identityKeys: mention.kind === 'resolved' ? mention.identityKeys : [],
  }));
}

export function deriveWaitingOnIdentities(thread: Thread): WaitingOnIdentity[] {
  for (let index = thread.comments.length - 1; index >= 0; index--) {
    const comment = thread.comments[index];
    const structured = structuredAssignments(comment);
    const mentioned =
      structured ??
      extractMentions(comment.body).map((handle) => ({ handle, identityKeys: [] }));
    if (mentioned.length === 0) continue;

    const laterComments = thread.comments.slice(index + 1);
    const laterKeys = new Set(
      laterComments.flatMap((laterComment) => laterComment.authorIdentityKeys || [])
    );
    const laterHandles = new Set(
      laterComments.map((laterComment) =>
        normalizeIdentity(laterComment.authorLogin || laterComment.author)
      )
    );
    return mentioned.filter((identity) =>
      identity.identityKeys.length > 0
        ? !keyIntersects(identity.identityKeys, laterKeys)
        : !laterHandles.has(normalizeIdentity(identity.handle))
    );
  }
  return [];
}

export function deriveWaitingOn(thread: Thread): string[] {
  return deriveWaitingOnIdentities(thread).map((identity) => identity.handle);
}

export function isWaitingOnViewer(
  thread: Thread,
  viewerNames: string[],
  viewerIdentityKeys: readonly string[] = []
): boolean {
  const viewers = new Set(viewerNames.filter(Boolean).map(normalizeIdentity));
  const viewerKeys = new Set(viewerIdentityKeys);
  return deriveWaitingOnIdentities(thread).some((identity) =>
    identity.identityKeys.length > 0
      ? keyIntersects(identity.identityKeys, viewerKeys)
      : viewers.has(normalizeIdentity(identity.handle))
  );
}

export function needsReanchor(thread: Thread): boolean {
  return (
    thread.located === false ||
    thread.confidence === 'needs-confirmation' ||
    thread.confidence === 'orphaned'
  );
}

export function summarizeReview(
  threads: Thread[],
  viewerNames: string[],
  viewerIdentityKeys: readonly string[] = []
): ReviewSummary {
  const open = threads.filter((thread) => !thread.resolved);
  const byIntent = (intent: ThreadIntent) =>
    open.filter((thread) => threadIntent(thread) === intent).length;
  return {
    open: open.length,
    question: byIntent('question'),
    suggestion: byIntent('suggestion'),
    blocking: byIntent('blocking'),
    waitingOnViewer: open.filter((thread) =>
      isWaitingOnViewer(thread, viewerNames, viewerIdentityKeys)
    ).length,
  };
}

export function filterThreads(
  threads: Thread[],
  filter: ReviewFilter,
  viewerNames: string[],
  viewerIdentityKeys: readonly string[] = []
): Thread[] {
  if (filter === 'all') return threads;

  const open = threads.filter((thread) => !thread.resolved);
  if (filter === 'question' || filter === 'suggestion' || filter === 'blocking') {
    return open.filter((thread) => threadIntent(thread) === filter);
  }
  if (filter === 'mine') {
    return open.filter((thread) => isWaitingOnViewer(thread, viewerNames, viewerIdentityKeys));
  }
  if (filter === 'needs-reanchor') {
    return open.filter(needsReanchor);
  }
  return open;
}

// ---- Search & sort (#34) ----

export type ThreadSort = 'document' | 'newest' | 'oldest' | 'blocking';

/** True when any of the thread's comments matches the query by body text,
 *  author display name, author login, or @mention handle. Case-insensitive. */
export function threadMatchesQuery(thread: Thread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (thread.anchor.quote.toLowerCase().includes(q)) return true;
  return thread.comments.some((comment) => {
    if (comment.body.toLowerCase().includes(q)) return true;
    if (comment.author.toLowerCase().includes(q)) return true;
    if (comment.authorLogin && comment.authorLogin.toLowerCase().includes(q)) return true;
    return (comment.mentions || []).some((mention) =>
      normalizeIdentity(mention.handle).includes(normalizeIdentity(q))
    );
  });
}

/** Filter threads by a free-text query (see threadMatchesQuery). Empty query is a
 *  no-op so search composes cleanly with the intent filters. */
export function searchThreads(threads: Thread[], query: string): Thread[] {
  if (!query.trim()) return threads;
  return threads.filter((thread) => threadMatchesQuery(thread, query));
}

/** The timestamp used to order a thread: its latest comment, else the thread's. */
function threadTime(thread: Thread): number {
  const last = thread.comments[thread.comments.length - 1];
  const iso = last?.createdAt ?? thread.createdAt;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

const BLOCKING_RANK: Record<ThreadIntent, number> = { blocking: 0, question: 1, suggestion: 1 };

/** Return a new, stably-sorted array (never mutates the input). 'blocking' puts
 *  blocking threads first, then falls back to newest within each group. */
export function sortThreads(threads: Thread[], sort: ThreadSort, positions?: ReadonlyMap<string, number>): Thread[] {
  const withIndex = threads.map((thread, index) => ({ thread, index }));
  withIndex.sort((a, b) => {
    if (sort === 'document') {
      const left = positions ? positions.get(a.thread.id) ?? Infinity : a.thread.located === false ? Infinity : a.thread.anchor.start;
      const right = positions ? positions.get(b.thread.id) ?? Infinity : b.thread.located === false ? Infinity : b.thread.anchor.start;
      if (left !== right) return left < right ? -1 : 1;
    } else if (sort === 'blocking') {
      const rank = BLOCKING_RANK[threadIntent(a.thread)] - BLOCKING_RANK[threadIntent(b.thread)];
      if (rank !== 0) return rank;
      const time = threadTime(b.thread) - threadTime(a.thread);
      if (time !== 0) return time;
    } else {
      const time =
        sort === 'oldest'
          ? threadTime(a.thread) - threadTime(b.thread)
          : threadTime(b.thread) - threadTime(a.thread);
      if (time !== 0) return time;
    }
    return a.index - b.index; // stable tiebreak
  });
  return withIndex.map((entry) => entry.thread);
}

export function alignThreadCards(cards: readonly { top: number; offset: number; anchorTop?: number }[]): number[] {
  let shift = 0;
  return cards.map(card => {
    const naturalTop = card.top - card.offset + shift;
    const offset = card.anchorTop === undefined ? 0 : Math.max(0, card.anchorTop - naturalTop);
    shift += offset - card.offset;
    return offset;
  });
}

export function packFocusedThreadCards(
  cards: readonly { id: string; top: number; height: number }[],
  activeId: string,
  gap = 12
): { id: string; top: number; height: number }[] {
  const activeIndex = cards.findIndex(card => card.id === activeId);
  if (activeIndex < 0) return [];
  let minimumTop = 0;
  const minimumTops = cards.map(card => {
    const top = minimumTop;
    minimumTop += card.height + gap;
    return top;
  });
  const active = { ...cards[activeIndex], top: Math.max(minimumTops[activeIndex], cards[activeIndex].top) };
  const before: { id: string; top: number; height: number }[] = [];
  let boundary = active.top;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const card = cards[index];
    const top = Math.max(minimumTops[index], Math.min(card.top, boundary - card.height - gap));
    before.unshift({ ...card, top });
    boundary = top;
  }
  let bottom = active.top + active.height;
  const after = cards.slice(activeIndex + 1).map(card => {
    const top = Math.max(card.top, bottom + gap);
    bottom = top + card.height;
    return { ...card, top };
  });
  return [...before, active, ...after];
}
