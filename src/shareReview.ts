// Share-a-review-link (#111).
//
// "Share for review" lets an author hand a review invitation to stakeholders who
// don't use Git: it produces a stable DocThread deep link (built by the caller
// from the same canonical source identity the app already uses), optionally
// emails allow-listed invitees through the existing /api/notify relay, and tracks
// lightweight participation (invited → reviewed) in the Review Status panel.
//
// This module is intentionally DOM/React/Vite-free so the parsing, allow-list
// partitioning, email building, participation derivation, and the localStorage
// wrappers stay deterministic and unit-testable under `node --test`. Invite
// records are stored locally (keyed by canonical source identity, like recents /
// editor prefs) so the review sidecar schema — and its merge semantics — are
// left untouched. "Opened" tracking and a short `/r/<code>` URL are deferred
// (they need server-side infrastructure); see the issue for the v1 boundary.

import { filterAllowedRecipients } from './notifyAllowlist.ts';
import type { Thread } from './types.ts';

/** A stakeholder invited to review the current document. */
export interface Invite {
  /** Normalized (lower-cased, trimmed) email address — the de-dupe key. */
  readonly email: string;
  /** Optional display name captured at invite time, for the participation list. */
  readonly displayName?: string;
  /** ISO timestamp the invitation was sent. */
  readonly invitedAt: string;
  /** Optional personal message included in the invitation email. */
  readonly message?: string;
}

export type ParticipationStatus = 'invited' | 'reviewed';

/** One row of the Review Status participation list. */
export interface Participation {
  readonly email: string;
  readonly displayName?: string;
  readonly invitedAt: string;
  readonly status: ParticipationStatus;
}

const EMAIL_SPLIT = /[\s,;]+/;

/**
 * Parse a free-text list of addresses (comma / semicolon / whitespace / newline
 * separated) into trimmed, case-insensitively de-duplicated entries, preserving
 * first-seen order. Does not validate shape — allow-list partitioning does that.
 */
export function parseInviteEmails(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of String(raw ?? '').split(EMAIL_SPLIT)) {
    const email = piece.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export interface PartitionedInvites {
  /** Well-formed addresses within the allow-list — these will be contacted. */
  readonly allowed: string[];
  /** Malformed or out-of-allow-list addresses — these are never contacted. */
  readonly rejected: string[];
}

/**
 * Split addresses into allow-listed (safe to email) vs rejected (never
 * contacted). Reuses the same `filterAllowedRecipients` the notify relay applies
 * server-side, so the client preview matches what the relay would actually send.
 */
export function partitionInviteEmails(
  emails: readonly string[],
  allowedDomains: string[]
): PartitionedInvites {
  const allowed = filterAllowedRecipients([...emails], allowedDomains);
  const allowedSet = new Set(allowed.map((address) => address.toLowerCase()));
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = String(raw).trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowedSet.has(key)) rejected.push(email);
  }
  return { allowed, rejected };
}

/** Build an Invite record for an allow-listed address (email lower-cased). */
export function makeInvite(
  email: string,
  invitedAt: string,
  message?: string,
  displayName?: string
): Invite {
  const invite: Invite = { email: email.trim().toLowerCase(), invitedAt };
  const trimmedName = displayName?.trim();
  const trimmedMessage = message?.trim();
  return {
    ...invite,
    ...(trimmedName ? { displayName: trimmedName } : {}),
    ...(trimmedMessage ? { message: trimmedMessage } : {}),
  };
}

/**
 * Merge freshly-sent invites into an existing list, de-duplicated by email
 * (case-insensitive). A re-invite refreshes the record (newest wins). Pure —
 * never mutates its inputs; order follows first-seen email.
 */
export function mergeInvites(existing: readonly Invite[], added: readonly Invite[]): Invite[] {
  const byEmail = new Map<string, Invite>();
  for (const invite of existing) byEmail.set(invite.email.toLowerCase(), invite);
  for (const invite of added) byEmail.set(invite.email.toLowerCase(), invite);
  return [...byEmail.values()];
}

function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return (at >= 0 ? email.slice(0, at) : email).toLowerCase();
}

/**
 * Derive per-invitee participation from the current threads. An invitee is
 * "reviewed" once a comment authored by them appears in a non-deleted thread,
 * matched by display name, provider login, or email local-part (a best-effort
 * bridge since comments store author/login, not email). Everyone else is
 * "invited". Anonymous / non-invited commenters are never listed here.
 */
export function deriveParticipation(
  invites: readonly Invite[],
  threads: readonly Thread[]
): Participation[] {
  const authorNames = new Set<string>();
  const authorLogins = new Set<string>();
  for (const thread of threads) {
    if (thread.deletedAt) continue;
    for (const comment of thread.comments) {
      if (comment.author) authorNames.add(comment.author.toLowerCase());
      if (comment.authorLogin) authorLogins.add(comment.authorLogin.toLowerCase());
    }
  }
  return invites.map((invite) => {
    const local = emailLocalPart(invite.email);
    const name = invite.displayName?.toLowerCase();
    const reviewed =
      (name ? authorNames.has(name) : false) ||
      authorLogins.has(local) ||
      authorNames.has(local);
    return {
      email: invite.email,
      ...(invite.displayName ? { displayName: invite.displayName } : {}),
      invitedAt: invite.invitedAt,
      status: reviewed ? 'reviewed' : 'invited',
    };
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the share-invitation email subject + HTML body. */
export function buildShareInviteEmail(args: {
  actor: string;
  docLabel: string;
  docUrl: string;
  message?: string;
}): { subject: string; html: string } {
  const subject = `DocThread: ${args.actor} invited you to review “${args.docLabel}”`;
  const note = args.message?.trim()
    ? `<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #0969da;background:#f6f8fa">` +
      `${escapeHtml(args.message.trim())}</blockquote>`
    : '';
  const html =
    `<div style="font-family:Segoe UI,Aptos,Arial,sans-serif;font-size:14px;color:#111">` +
    `<p><strong>${escapeHtml(args.actor)}</strong> invited you to review ` +
    `<strong>${escapeHtml(args.docLabel)}</strong> in DocThread — a Word-like review ` +
    `experience for Markdown and Azure DevOps work items.</p>` +
    note +
    `<p><a href="${escapeHtml(args.docUrl)}">Open the document to review</a></p>` +
    `<p style="color:#777;font-size:12px">You received this because you were invited to a ` +
    `DocThread review. No sign-up is required for public documents; private ones prompt ` +
    `you to sign in with the source provider.</p>` +
    `</div>`;
  return { subject, html };
}

// ---- localStorage wrappers (identity-keyed; safe no-ops when unavailable) ----

export const INVITES_KEY_PREFIX = 'docthread:invites:v1:';

/** Storage key for a document's invites, namespaced by its canonical source key. */
export function invitesStorageKey(sourceKey: string): string {
  return `${INVITES_KEY_PREFIX}${sourceKey}`;
}

/** Parse a stored invites JSON string into a validated list (malformed → dropped). */
export function parseInvites(raw: string | null | undefined): Invite[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Invite[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.email !== 'string' || !record.email) continue;
    if (typeof record.invitedAt !== 'string' || !record.invitedAt) continue;
    const email = record.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const invite: Invite = { email, invitedAt: record.invitedAt };
    out.push({
      ...invite,
      ...(typeof record.displayName === 'string' && record.displayName
        ? { displayName: record.displayName }
        : {}),
      ...(typeof record.message === 'string' && record.message
        ? { message: record.message }
        : {}),
    });
  }
  return out;
}

export function loadInvites(sourceKey: string): Invite[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return parseInvites(localStorage.getItem(invitesStorageKey(sourceKey)));
  } catch {
    return [];
  }
}

export function storeInvites(sourceKey: string, invites: readonly Invite[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(invitesStorageKey(sourceKey), JSON.stringify(invites));
  } catch {
    /* ignore quota/serialization errors — invites are a convenience only */
  }
}
