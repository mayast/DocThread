import type { MentionReference } from './types.ts';
import type { MentionContact } from './mentionContacts.ts';

export interface NotifyEmailPayload {
  to: string[];
  subject: string;
  html: string;
}

export interface NotifyEmailResult {
  delivered: boolean;
  status?: number;
  reason?: string;
}

/**
 * Send a mention-notification email by POSTing { to, subject, html } to the
 * notify endpoint, which forwards it server-side to the Outlook Logic App
 * webhook. Never throws — a failed/undelivered send is reported in the result so
 * the caller can surface it without breaking the comment flow. The endpoint is
 * injected (from auth.NOTIFY_ENDPOINT) so this module stays free of Vite-only
 * `import.meta.env` coupling and remains unit-testable under `node --test`.
 */
export async function sendMentionEmail(
  endpoint: string,
  payload: NotifyEmailPayload,
  fetchImpl: typeof fetch = fetch
): Promise<NotifyEmailResult> {
  const to = [...new Set(payload.to.map((address) => address.trim()).filter(Boolean))];
  if (to.length === 0) return { delivered: false, reason: 'no recipients' };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject: payload.subject, html: payload.html }),
    });
    const data = (await response.json().catch(() => ({}))) as NotifyEmailResult;
    return {
      delivered: Boolean(data?.delivered),
      status: typeof data?.status === 'number' ? data.status : response.status,
      reason: data?.reason,
    };
  } catch (error: any) {
    return { delivered: false, reason: error?.message || String(error) };
  }
}

/**
 * Collect the de-duplicated email recipients for a comment's @mentions. Only
 * resolved mentions for which we have a cached contact address are returned. This
 * is intentionally independent of whether the comment is persisted "local-only":
 * emailing a mentioned person via the relay needs no repository write access, so a
 * read-only source must not suppress the notification.
 */
export function collectMentionEmailTargets(
  mentions: readonly MentionReference[] | undefined,
  lookup: (subjectKey: string) => MentionContact | undefined
): MentionContact[] {
  return [
    ...new Map(
      (mentions || []).flatMap((mention) => {
        if (mention.kind !== 'resolved') return [];
        const contact = lookup(mention.subjectKey);
        return contact ? ([[contact.email, contact]] as [string, MentionContact][]) : [];
      })
    ).values(),
  ];
}

/** Build the notification email subject + HTML body for a review mention. */
export function buildMentionEmail(args: {
  actor: string;
  docLabel: string;
  docUrl?: string;
  commentBody: string;
  intent?: string;
}): { subject: string; html: string } {
  const safe = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = `DocThread: ${args.actor} mentioned you in “${args.docLabel}”`;
  const link = args.docUrl
    ? `<p><a href="${safe(args.docUrl)}">Open the document in DocThread</a></p>`
    : '';
  const intentLine = args.intent
    ? `<p style="color:#555;margin:0 0 8px 0"><strong>${safe(args.intent)}</strong></p>`
    : '';
  const html =
    `<div style="font-family:Segoe UI,Aptos,Arial,sans-serif;font-size:14px;color:#111">` +
    `<p><strong>${safe(args.actor)}</strong> mentioned you in a DocThread review of ` +
    `<strong>${safe(args.docLabel)}</strong>.</p>` +
    intentLine +
    `<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #0969da;background:#f6f8fa">` +
    `${safe(args.commentBody)}</blockquote>` +
    link +
    `<p style="color:#777;font-size:12px">You received this because you were @mentioned in a DocThread review.</p>` +
    `</div>`;
  return { subject, html };
}
