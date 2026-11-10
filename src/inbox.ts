// In-app notification center (#31).
//
// Derives "what needs the viewer" from the review threads already in memory —
// @mentions of me, replies on my threads, and assignments (threads currently
// waiting on me) — and tracks read/unread state locally. It reuses the existing
// waiting-on derivation so the inbox never forks the mention/assignment logic.
//
// Pure + localStorage-guarded so the aggregation stays deterministic and
// unit-testable under `node --test`; the storage wrappers no-op when unavailable.

import type { Comment, MentionReference, Thread, ThreadIntent } from './types.ts';
import {
  extractMentions,
  isWaitingOnViewer,
  normalizeIdentity,
} from './review.ts';

export type InboxKind = 'mention' | 'reply' | 'assignment';

export interface InboxItem {
  /** Stable id (`kind:commentId`) so read-state survives re-aggregation. */
  id: string;
  kind: InboxKind;
  threadId: string;
  commentId: string;
  /** Display name of the person who triggered the item. */
  actor: string;
  /** Short, single-line preview of the comment body. */
  snippet: string;
  /** ISO timestamp used for ordering and the read cutoff. */
  at: string;
  intent?: ThreadIntent;
}

export interface InboxViewer {
  /** Stable identity keys of the viewer (e.g. `github:…`, `entra:…`). */
  identityKeys: readonly string[];
  /** Viewer display names / logins, for handle-based fallback matching. */
  names: readonly string[];
}

// Assignment (still waiting on me) is the most actionable, then a direct
// mention, then a plain reply. Only one row is kept per comment.
const KIND_PRIORITY: Record<InboxKind, number> = { assignment: 3, mention: 2, reply: 1 };

function snippet(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isViewerAuthored(comment: Comment, viewerKeys: ReadonlySet<string>, viewerNames: ReadonlySet<string>): boolean {
  if (comment.authorIdentityKeys?.some((key) => viewerKeys.has(key))) return true;
  return viewerNames.has(normalizeIdentity(comment.authorLogin || comment.author));
}

function mentionsViewer(
  mentions: readonly MentionReference[] | undefined,
  viewerKeys: ReadonlySet<string>,
  viewerNames: ReadonlySet<string>
): boolean {
  return (mentions || []).some((mention) =>
    mention.kind === 'resolved'
      ? viewerKeys.has(mention.subjectKey) ||
        (mention.identityKeys || []).some((key) => viewerKeys.has(key))
      : viewerNames.has(normalizeIdentity(mention.handle))
  );
}

/** The latest comment that assigns someone (mirrors deriveWaitingOnIdentities' scan). */
function findAssigningComment(thread: Thread): Comment | null {
  for (let index = thread.comments.length - 1; index >= 0; index--) {
    const comment = thread.comments[index];
    const structured =
      comment.identityVersion === 1 && comment.mentions ? comment.mentions.length > 0 : false;
    const extracted = extractMentions(comment.body).length > 0;
    if (structured || extracted) return comment;
  }
  return null;
}

/**
 * Build the viewer's notification inbox from the current threads. Emits at most
 * one item per comment (highest-priority kind wins) and never surfaces the
 * viewer's own comments (no self-notifications). Sorted newest-first.
 */
export function buildInbox(threads: readonly Thread[], viewer: InboxViewer): InboxItem[] {
  const viewerKeys = new Set(viewer.identityKeys);
  const viewerNames = new Set(viewer.names.filter(Boolean).map((name) => normalizeIdentity(name)));
  // No identity → nothing can be attributed to the viewer.
  if (viewerKeys.size === 0 && viewerNames.size === 0) return [];

  const byComment = new Map<string, InboxItem>();
  const put = (kind: InboxKind, thread: Thread, comment: Comment): void => {
    const existing = byComment.get(comment.id);
    if (existing && KIND_PRIORITY[existing.kind] >= KIND_PRIORITY[kind]) return;
    byComment.set(comment.id, {
      id: `${kind}:${comment.id}`,
      kind,
      threadId: thread.id,
      commentId: comment.id,
      actor: comment.author,
      snippet: snippet(comment.body),
      at: comment.createdAt,
      ...(thread.intent ? { intent: thread.intent } : {}),
    });
  };

  for (const thread of threads) {
    if (thread.deletedAt) continue;
    const viewerParticipated = thread.comments.some((comment) =>
      isViewerAuthored(comment, viewerKeys, viewerNames)
    );

    thread.comments.forEach((comment, index) => {
      if (isViewerAuthored(comment, viewerKeys, viewerNames)) return; // no self-notifications
      if (mentionsViewer(comment.mentions, viewerKeys, viewerNames)) {
        put('mention', thread, comment);
        return;
      }
      if (
        viewerParticipated &&
        thread.comments
          .slice(0, index)
          .some((earlier) => isViewerAuthored(earlier, viewerKeys, viewerNames))
      ) {
        put('reply', thread, comment);
      }
    });

    // Assignment: the viewer is currently the one being waited on. Supersedes a
    // plain mention row for the same assigning comment.
    if (isWaitingOnViewer(thread, [...viewer.names], viewer.identityKeys)) {
      const assigning = findAssigningComment(thread);
      if (assigning && !isViewerAuthored(assigning, viewerKeys, viewerNames)) {
        put('assignment', thread, assigning);
      }
    }
  }

  return [...byComment.values()].sort((a, b) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

// ---- Read / unread state -------------------------------------------------

/**
 * Read state is a `lastSeenAt` cutoff plus a small set of individually-read ids.
 * "Mark all read" advances `lastSeenAt` and clears the id set, keeping it bounded.
 */
export interface InboxReadState {
  lastSeenAt: string;
  readIds: string[];
}

export const INBOX_READ_KEY = 'docthread:inbox:read';
const EPOCH = '1970-01-01T00:00:00.000Z';
const READ_IDS_CAP = 500;

export function emptyReadState(): InboxReadState {
  return { lastSeenAt: EPOCH, readIds: [] };
}

export function isUnread(item: InboxItem, state: InboxReadState): boolean {
  if (state.readIds.includes(item.id)) return false;
  return item.at > state.lastSeenAt;
}

export function unreadCount(items: readonly InboxItem[], state: InboxReadState): number {
  return items.reduce((count, item) => (isUnread(item, state) ? count + 1 : count), 0);
}

export function markItemRead(state: InboxReadState, id: string): InboxReadState {
  if (state.readIds.includes(id)) return state;
  const readIds = [id, ...state.readIds].slice(0, READ_IDS_CAP);
  return { lastSeenAt: state.lastSeenAt, readIds };
}

export function markAllRead(items: readonly InboxItem[], nowIso: string): InboxReadState {
  // Advance the cutoff to the newest item (or now) and clear the id set.
  const newest = items.reduce((max, item) => (item.at > max ? item.at : max), EPOCH);
  const lastSeenAt = newest > nowIso ? newest : nowIso;
  return { lastSeenAt, readIds: [] };
}

// ---- localStorage wrappers (safe no-ops when storage is unavailable) ----

export function parseReadState(raw: string | null | undefined): InboxReadState {
  if (!raw) return emptyReadState();
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const lastSeenAt = typeof data?.lastSeenAt === 'string' ? data.lastSeenAt : EPOCH;
    const readIds = Array.isArray(data?.readIds)
      ? data.readIds.filter((id): id is string => typeof id === 'string').slice(0, READ_IDS_CAP)
      : [];
    return { lastSeenAt, readIds };
  } catch {
    return emptyReadState();
  }
}

export function loadInboxReadState(): InboxReadState {
  if (typeof localStorage === 'undefined') return emptyReadState();
  try {
    return parseReadState(localStorage.getItem(INBOX_READ_KEY));
  } catch {
    return emptyReadState();
  }
}

export function storeInboxReadState(state: InboxReadState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(INBOX_READ_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota/serialization errors — read-state is a convenience only */
  }
}
