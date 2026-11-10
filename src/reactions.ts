// Lightweight comment reactions (#37).
//
// Reactions are a tiny CRDT-style event log stored on each comment. Every add or
// remove is an event carrying the reactor's stable identity key and a timestamp.
// The persisted/merged form is *compacted* to at most one entry per
// (emoji, reactor): the latest event wins, and a `removed` tombstone is kept so a
// concurrent copy of an older add can never resurrect a toggled-off reaction.
//
// This module is intentionally dependency-free (only a type import) so it can be
// unit-tested under `node --test` and shared by the schema, the merge, and the UI.

import type { Reaction } from './types';

/**
 * Curated allow-list of agreement/acknowledgement reactions. Kept to simple,
 * widely-rendered codepoints so they round-trip cleanly through GitHub (UTF-8
 * blob) and Azure DevOps (UTF-8 base64) storage and display consistently.
 */
export const REACTION_EMOJIS = ['👍', '✅', '👀', '🎉', '❤️', '😞'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

const REACTION_EMOJI_SET = new Set<string>(REACTION_EMOJIS);

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return REACTION_EMOJI_SET.has(value);
}

/**
 * Build a schema-valid Azure DevOps reactor identity key for a viewer who has an
 * ADO login but no Entra object id, so reactions work on ADO work items just like
 * they do on GitHub. Segments are sanitized to satisfy the identity-key grammar
 * (`azure-devops:<org>:<login>` — no ':', '@', or whitespace). Returns null when
 * either part is missing.
 */
export function adoReactionIdentityKey(
  organization: string | undefined,
  login: string | undefined
): string | null {
  const clean = (value: string) => value.trim().replace(/[:@\s]+/g, '_');
  const org = organization ? clean(organization) : '';
  const who = login ? clean(login) : '';
  if (!org || !who) return null;
  return `azure-devops:${org}:${who}`;
}

export interface ReactionTally {
  emoji: ReactionEmoji;
  count: number;
  /** True when any of the viewer's identity keys reacted with this emoji. */
  reactedByViewer: boolean;
  /** Reactor display names (falls back to the identity key), for tooltips. */
  names: string[];
}

function reactionKey(reaction: Reaction): string {
  // NUL separates the two fields so no emoji/key combination can collide.
  return `${reaction.emoji}\u0000${reaction.by}`;
}

// On identical timestamps a removal wins deterministically so a toggle-off is
// never resurrected by a concurrent copy of the add it cancels.
function rank(reaction: Reaction): number {
  return reaction.removed ? 1 : 0;
}

function compareReactions(a: Reaction, b: Reaction): number {
  if (a.emoji !== b.emoji) return a.emoji < b.emoji ? -1 : 1;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return 0;
}

/**
 * Reduce an event log to at most one entry per (emoji, reactor) — the latest by
 * timestamp — and return it in a stable, deterministic order. Tombstones are
 * retained. Used by both persistence merge and toggling so the stored form stays
 * bounded and canonical.
 */
export function compactReactions(events: readonly Reaction[]): Reaction[] {
  const latest = new Map<string, Reaction>();
  for (const event of events) {
    const key = reactionKey(event);
    const prev = latest.get(key);
    if (!prev || event.at > prev.at || (event.at === prev.at && rank(event) >= rank(prev))) {
      latest.set(key, event);
    }
  }
  return [...latest.values()].sort(compareReactions);
}

/**
 * Merge two reaction event logs into one compacted list without clobbering
 * concurrent reactions. Returns undefined when both sides are empty so the
 * optional `reactions` field can be dropped from the persisted comment.
 */
export function mergeReactionLists(
  a: readonly Reaction[] | undefined,
  b: readonly Reaction[] | undefined
): Reaction[] | undefined {
  if ((!a || a.length === 0) && (!b || b.length === 0)) return undefined;
  const merged = compactReactions([...(a ?? []), ...(b ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

/** Live (non-removed) reactions, one per (emoji, reactor). */
export function effectiveReactions(reactions: readonly Reaction[] | undefined): Reaction[] {
  if (!reactions || reactions.length === 0) return [];
  return compactReactions(reactions).filter((reaction) => !reaction.removed);
}

/** Does any of the viewer's identity keys currently react with `emoji`? */
export function viewerHasReacted(
  reactions: readonly Reaction[] | undefined,
  emoji: ReactionEmoji,
  viewerIdentityKeys: readonly string[]
): boolean {
  const viewer = new Set(viewerIdentityKeys);
  return effectiveReactions(reactions).some(
    (reaction) => reaction.emoji === emoji && viewer.has(reaction.by)
  );
}

/**
 * Aggregate reactions into per-emoji tallies in allow-list order, dropping
 * emojis with no live reactions.
 */
export function tallyReactions(
  reactions: readonly Reaction[] | undefined,
  viewerIdentityKeys: readonly string[] = []
): ReactionTally[] {
  const live = effectiveReactions(reactions);
  const viewer = new Set(viewerIdentityKeys);
  return REACTION_EMOJIS.map((emoji) => {
    const forEmoji = live.filter((reaction) => reaction.emoji === emoji);
    return {
      emoji,
      count: forEmoji.length,
      reactedByViewer: forEmoji.some((reaction) => viewer.has(reaction.by)),
      names: forEmoji.map((reaction) => reaction.byName || reaction.by),
    };
  }).filter((tally) => tally.count > 0);
}

/**
 * Toggle the viewer's reaction for one emoji, returning the new compacted
 * reactions array. `by` is the reactor's stable identity key; `at` is the event
 * time. If the viewer already reacts with this emoji the result records a
 * removal tombstone; otherwise it records the reaction.
 */
export function toggleReaction(
  reactions: readonly Reaction[] | undefined,
  emoji: ReactionEmoji,
  by: string,
  byName: string | undefined,
  at: string
): Reaction[] {
  const alreadyOn = effectiveReactions(reactions).some(
    (reaction) => reaction.emoji === emoji && reaction.by === by
  );
  const event: Reaction = {
    emoji,
    by,
    at,
    ...(byName ? { byName } : {}),
    ...(alreadyOn ? { removed: true as const } : {}),
  };
  return compactReactions([...(reactions ?? []), event]);
}
