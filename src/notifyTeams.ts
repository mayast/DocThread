// Optional Microsoft Teams delivery for review notifications (#31).
//
// Reuses the same `/api/notify` relay as the email channel: the client POSTs
// { to, teams: <card> }, and the relay forwards the card to the TEAMS_WEBHOOK_URL
// application setting *after* filtering `to` against the same recipient domain
// allowlist — so Teams delivery can never be an open relay either.
//
// Kept dependency-free (the endpoint is injected) so it stays unit-testable under
// `node --test` alongside the email builder.

export interface TeamsNotifyResult {
  delivered: boolean;
  status?: number;
  reason?: string;
}

/**
 * Build a Teams-compatible MessageCard for a review mention. MessageCard is
 * accepted by both classic Incoming Webhooks and the newer Workflows connector,
 * so it works with whatever TEAMS_WEBHOOK_URL points at. Content is data-only
 * (no HTML); Teams renders the text and the "Open in DocThread" action.
 */
export function buildTeamsMessage(args: {
  actor: string;
  docLabel: string;
  docUrl?: string;
  commentBody: string;
  intent?: string;
  recipients?: string[];
}): Record<string, unknown> {
  const facts: Array<{ name: string; value: string }> = [];
  if (args.intent) facts.push({ name: 'Intent', value: args.intent });
  if (args.recipients && args.recipients.length > 0) {
    facts.push({ name: 'For', value: args.recipients.join(', ') });
  }
  const card: Record<string, unknown> = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: '0969DA',
    summary: `DocThread: ${args.actor} mentioned you in ${args.docLabel}`,
    title: `${args.actor} mentioned you in “${args.docLabel}”`,
    sections: [
      {
        activityTitle: `${args.actor} mentioned you`,
        text: args.commentBody,
        markdown: false,
        ...(facts.length > 0 ? { facts } : {}),
      },
    ],
  };
  if (args.docUrl) {
    card.potentialAction = [
      {
        '@type': 'OpenUri',
        name: 'Open in DocThread',
        targets: [{ os: 'default', uri: args.docUrl }],
      },
    ];
  }
  return card;
}

/**
 * Deliver a Teams card via the notify relay. Never throws — a failed/undelivered
 * send is reported so the caller can surface it without breaking the comment flow.
 */
export async function sendTeamsNotification(
  endpoint: string,
  payload: { to: string[]; card: unknown },
  fetchImpl: typeof fetch = fetch
): Promise<TeamsNotifyResult> {
  const to = [...new Set(payload.to.map((address) => address.trim()).filter(Boolean))];
  if (to.length === 0) return { delivered: false, reason: 'no recipients' };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, teams: payload.card }),
    });
    const data = (await response.json().catch(() => ({}))) as TeamsNotifyResult;
    return {
      delivered: Boolean(data?.delivered),
      status: typeof data?.status === 'number' ? data.status : response.status,
      reason: data?.reason,
    };
  } catch (error: any) {
    return { delivered: false, reason: error?.message || String(error) };
  }
}
