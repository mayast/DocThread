import { useEffect, useRef, useState } from 'react';
import { parseInviteEmails, partitionInviteEmails, type Participation } from '../shareReview';
import { Dialog } from './Dialog';

interface ShareResult {
  invited: number;
  rejected: string[];
  delivered: boolean;
  reason?: string;
}

interface Props {
  /** The stable review link to copy/share. */
  shareLink: string;
  /** Human label for the document being shared. */
  docLabel: string;
  /** Client mirror of the notify relay allow-list, for a live send/skip preview. */
  allowedDomains: string[];
  /** Send the invitation to allow-listed addresses; returns the outcome. */
  onSubmit: (emails: string, message: string) => Promise<ShareResult>;
  onClose: () => void;
  participation?: Participation[];
}

/**
 * "Share for review" dialog (#111): copy a stable review link and optionally
 * email allow-listed stakeholders an invitation with an optional message. The
 * link itself needs no backend — it encodes the canonical source identity and
 * respects the provider's own auth (public opens directly; private prompts
 * sign-in). Email goes through the existing /api/notify allow-listed relay.
 */
export function ShareModal({ shareLink, docLabel, allowedDomains, onSubmit, onClose, participation = [] }: Props) {
  const [emails, setEmails] = useState('');
  const [message, setMessage] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ShareResult | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [sendError, setSendError] = useState('');
  const linkRef = useRef<HTMLInputElement>(null);
  const hasInput = Boolean(emails.trim() || message.trim());
  const close = () => {
    if (sending || (hasInput && !window.confirm('Discard this unsent invitation?'))) return;
    onClose();
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasInput && !sending) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasInput, sending]);

  const parsed = parseInviteEmails(emails);
  const { allowed, rejected } = partitionInviteEmails(parsed, allowedDomains);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopyFailed(false);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setLinkCopied(false);
      setCopyFailed(true);
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  };

  const submit = async () => {
    if (allowed.length === 0 || sending) return;
    setSending(true);
    setSendError('');
    try {
      const outcome = await onSubmit(emails, message);
      setResult(outcome);
      if (outcome.delivered) { setEmails(''); setMessage(''); }
    } catch {
      setSendError('Invitation could not be sent. Your input has been kept.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog labelledBy="share-title" onClose={close} className="share-modal">
        <h3 id="share-title">Share for review</h3>
        <p className="share-doc-label">
          <strong>{docLabel}</strong>
        </p>

        <label className="share-field-label" htmlFor="share-link">
          Review link
        </label>
        <div className="share-link-row">
          <input
            id="share-link"
            ref={linkRef}
            className="share-link-input"
            type="text"
            readOnly
            value={shareLink}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="primary" onClick={copyLink}>
            {linkCopied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        {copyFailed && <p role="status">Clipboard unavailable. Select and copy the link above.</p>}
        <p className="share-hint">
          Reviewers need source access. An invitation does not grant it. Local-only feedback is not included in the shared review.
        </p>

        <label className="share-field-label" htmlFor="share-emails">
          Invite by email (optional)
        </label>
        <textarea
          id="share-emails"
          className="share-emails"
          rows={2}
          placeholder="alex@microsoft.com, jordan@microsoft.com"
          value={emails}
          onChange={(event) => setEmails(event.target.value)}
        />
        {rejected.length > 0 && (
          <p className="share-warning">
            Outside the allowed domains — will not be emailed: {rejected.join(', ')}
          </p>
        )}

        <label className="share-field-label" htmlFor="share-message">
          Message (optional)
        </label>
        <textarea
          id="share-message"
          className="share-message"
          rows={2}
          placeholder="Please review the API design section."
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />

        {result && (
          <p className={`share-result ${result.delivered ? 'ok' : 'warn'}`} role="status">
            {result.invited > 0
              ? result.delivered
                ? `Email requests accepted for ${result.invited} reviewer${result.invited === 1 ? '' : 's'}; delivery unconfirmed.`
                : `Recorded ${result.invited} invite${result.invited === 1 ? '' : 's'}, but the email request failed${
                    result.reason ? ` (${result.reason})` : ''
                  }.`
              : `No one was emailed${result.reason ? ` — ${result.reason}` : ''}.`}
            {result.rejected.length > 0 && ` Skipped (not allow-listed): ${result.rejected.join(', ')}.`}
          </p>
        )}
        {sendError && <p role="alert">{sendError}</p>}
        {participation.length > 0 && (
          <div className="review-participation" aria-label="Review invitations">
            <div className="review-participation-head">Invited reviewers</div>
            <ul className="review-participation-list">
              {participation.map(person => <li key={person.email} className={`participant participant-${person.status}`}><span title={person.email}>{person.displayName || person.email}</span><span>{person.status === 'reviewed' ? 'Commented' : 'Invited'}</span></li>)}
            </ul>
          </div>
        )}

        <div className="share-actions">
          <button type="button" onClick={close} disabled={sending}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={allowed.length === 0 || sending}
            title={
              allowed.length === 0
                ? 'Enter at least one allow-listed email to send an invitation'
                : 'Send the invitation email'
            }
          >
            {sending
              ? 'Sending…'
              : allowed.length > 0
              ? `Send invite${allowed.length === 1 ? '' : `s (${allowed.length})`}`
              : 'Send invite'}
          </button>
        </div>
    </Dialog>
  );
}
