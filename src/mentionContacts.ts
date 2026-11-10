// Transient, in-memory map of mention subjectKey -> contact (email + display name).
//
// The strict v2 review schema (see reviewSchema.ts `mentionAt`) accepts an exact
// key set for a resolved mention and deliberately does NOT persist an email
// address. But to email a mentioned person we still need their address at the
// moment their comment is submitted. This cache bridges that gap: the mention
// editor records the picked person's contact here when the mention resolves, and
// the comment-submit path reads it back to send the notification email. Nothing
// here is written to the review file, so no email addresses are persisted.
export interface MentionContact {
  email: string;
  displayName: string;
}

const contacts = new Map<string, MentionContact>();

/** Record a resolved mention's contact so a later submit can email them. */
export function rememberMentionContact(
  subjectKey: string,
  email: string | undefined | null,
  displayName: string
): void {
  const value = (email || '').trim();
  // Only keep genuine email addresses (Graph `mail` / UPN). Handles/logins are skipped.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return;
  contacts.set(subjectKey, { email: value, displayName });
}

/** Look up a previously recorded contact for a mention subject key. */
export function mentionContact(subjectKey: string): MentionContact | undefined {
  return contacts.get(subjectKey);
}
