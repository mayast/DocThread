// Core data model for DocThread.

import type { IdentityAuthority } from './identity';

export type NotificationRoute =
  | { kind: 'github'; nodeId: string }
  | {
      kind: 'ado-work-item';
      organization: string;
      identityId: string;
      descriptor: string;
      originId: string;
    }
  | { kind: 'none' };

export type NotificationDispatchState =
  | 'pending'
  | 'attempted'
  | 'delivered'
  | 'failed'
  | 'uncertain';

export interface NotificationDispatch {
  channel: 'github' | 'ado-work-item';
  state: NotificationDispatchState;
  /** Sorted subject keys included in the provider call. */
  recipientKeys: string[];
  attemptId?: string;
  attemptedAt?: string;
  providerUrl?: string;
  errorCode?: string;
}

export interface MentionSpan {
  start: number;
  length: number;
  text: string;
}

export type MentionReference =
  | (MentionSpan & {
      kind: 'resolved';
      subjectKey: string;
      identityKeys: string[];
      authority: IdentityAuthority;
      displayName: string;
      handle: string;
      route: NotificationRoute;
    })
  | (MentionSpan & {
      kind: 'unresolved';
      handle: string;
    });

/**
 * A durable anchor for a highlighted span of text.
 * Modeled on the W3C Web Annotation "TextQuoteSelector" + "TextPositionSelector":
 * we store the exact quote plus a window of surrounding context so the span can be
 * re-located even after the document is edited above or around it.
 */
export interface Anchor {
  /** The exact selected text at creation time. */
  quote: string;
  /** Up to N characters immediately before the quote (context for disambiguation). */
  prefix: string;
  /** Up to N characters immediately after the quote. */
  suffix: string;
  /** Approximate character offset of the quote start in the plain-text projection. */
  start: number;
}

export interface Comment {
  readonly id: string;
  readonly author: string;
  /** Provider identity used for reply/mention routing when available. */
  readonly authorLogin?: string;
  /** Provider-stable identities for this author. */
  readonly authorIdentityKeys?: string[];
  readonly identityVersion?: 1;
  readonly localOnly?: true;
  readonly mentions?: MentionReference[];
  readonly body: string;
  readonly createdAt: string; // ISO
  dispatch?: NotificationDispatch;
  /**
   * Lightweight emoji reactions on this comment (#37). Append-compacted event
   * log: at most one entry per (emoji, reactor identity key); a `removed` entry
   * is a toggle-off tombstone that prevents a concurrent copy from resurrecting
   * the reaction on merge. Absent on legacy sidecars.
   */
  reactions?: Reaction[];
}

/** A single emoji reaction event on a comment (#37). */
export interface Reaction {
  /** One of the curated reaction emojis (see src/reactions.ts). */
  readonly emoji: string;
  /** Stable identity key of the reactor (e.g. `github:octocat`). */
  readonly by: string;
  /** Reactor display name captured at reaction time, for tooltips. */
  readonly byName?: string;
  /** ISO timestamp of this add/remove event. */
  readonly at: string;
  /** Tombstone: the reactor toggled this emoji off. */
  readonly removed?: true;
}

/** Canonical fields that cannot change after a comment ID is first persisted. */
export interface ImmutableCommentCore {
  readonly id: string;
  readonly author: string;
  readonly authorLogin?: string;
  readonly authorIdentityKeys: readonly string[];
  readonly body: string;
  readonly createdAt: string;
  readonly mentions: readonly MentionReference[];
}

export type AnchorConfidence =
  | 'exact'
  | 'high'
  | 'medium'
  | 'needs-confirmation'
  | 'orphaned';

export type ThreadIntent = 'question' | 'suggestion' | 'blocking';

export interface ThreadClocks {
  resolutionAt: string;
  intentAt: string;
  anchorAt: string;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  comments: Comment[];
  resolved: boolean;
  createdAt: string; // ISO
  /** Review intent; absent on legacy sidecars means question. */
  intent?: ThreadIntent;
  /**
   * A proposed exact replacement for the anchored text (#35). The reviewer
   * captures it; the author clicks Apply to edit the document at the anchor and
   * resolve the thread. `appliedAt` records the (terminal) moment it was applied.
   */
  suggestion?: Suggestion;
  /** Per-field clocks; omitted fields inherit createdAt for legacy threads. */
  clocks?: Partial<ThreadClocks>;
  /** Terminal deletion tombstone. Deleted threads are never resurrected. */
  deletedAt?: string;
  /** Set at load time by the anchor engine: did we re-locate the span in the current doc? */
  located?: boolean;
  /** Set at load time by the anchor engine: how sure are we it's the right span? */
  confidence?: AnchorConfidence;
}

/** A suggested change attached to a thread (#35). */
export interface Suggestion {
  /** The proposed replacement for the thread's anchored text (may be empty to delete). */
  readonly replacement: string;
  /** Who authored the proposed replacement — a human reviewer or AI (#63). Absent = human. */
  readonly origin?: 'human' | 'ai';
  /** Optional skill that grounded an AI-generated suggestion (#92). */
  readonly skillName?: string;
  /** ISO timestamp the suggestion was applied to the document; absent while open. */
  readonly appliedAt?: string;
}

export type PersistedRepositoryIdentity =
  | { provider: 'github'; path: string }
  | { provider: 'azure-repos'; path: string };

export type GitHubVersionType = 'branch' | 'tag' | 'commit';

export type CanonicalSourceIdentity =
  | {
      provider: 'github';
      owner: string;
      repo: string;
      versionType: GitHubVersionType;
      ref: string;
      path: string;
    }
  | {
      provider: 'azure-repos';
      organization: string;
      project: string;
      repo: string;
      versionType: 'branch' | 'tag' | 'commit';
      ref: string;
      path: string;
    }
  | {
      provider: 'ado-workitem';
      organization: string;
      project: string;
      id: number;
    };

export interface DocThreadFileMeta {
  source?: 'github' | 'azure-repos' | 'ado-workitem' | 'ado';
  title?: string;
  sourceUrl?: string;
}

/** Legacy sidecar persisted at the lossy .docthread/<flat>.json path. */
export interface DocThreadFileV1 {
  schemaVersion: 1;
  docPath: string;
  threads: Thread[];
  updatedAt: string;
  /** Snapshot used when the reviewed source is not itself a Git file. */
  markdown?: string;
  meta?: DocThreadFileMeta;
}

/** Identity-aware sidecar persisted at .docthread/v2/<encoded segments>.json. */
export interface DocThreadFileV2 {
  schemaVersion: 2;
  source: PersistedRepositoryIdentity;
  docPath: string;
  threads: Thread[];
  updatedAt: string;
  markdown?: string;
  meta?: DocThreadFileMeta;
  legacyPath?: string;
  legacyRevision?: string;
}

/** Sidecar document persisted to localStorage or repository storage. */
export type DocThreadFile = DocThreadFileV1 | DocThreadFileV2;

export type StorageMode = 'local' | 'github';

export interface GitHubTarget {
  owner: string;
  repo: string;
  path: string; // path to the markdown file in the repo
  ref: string; // full ref name or commit SHA; GitHubSourceTarget supplies its type
  versionType?: GitHubVersionType;
  /** Runtime-only resolved commit used to pin reads. */
  commitSha?: string;
}

/** Canonical GitHub source identity after ref/path resolution. */
export interface GitHubSourceTarget extends GitHubTarget {
  kind: 'github';
  versionType: GitHubVersionType;
}
