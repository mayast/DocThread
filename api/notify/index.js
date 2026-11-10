// Azure Static Web Apps function: POST /api/notify
//
// The client posts { to: string[], subject: string, html: string } here when a
// reviewer @mentions someone. We forward the body server-side to the Azure Logic
// App webhook (NOTIFY_WEBHOOK_URL application setting), which sends the Outlook
// email. Keeping the flow URL server-side keeps it out of the client bundle and
// avoids browser CORS; the webhook secret is never exposed to the browser.
//
// SECURITY: to prevent this anonymous endpoint from being abused as an open
// relay that emails arbitrary external addresses, every recipient is filtered
// against a domain allowlist (NOTIFY_ALLOWED_DOMAINS, comma-separated; defaults
// to the project's own tenant domain) before anything is forwarded.
const DEFAULT_ALLOWED_DOMAINS = ['microsoft.com'];

function parseAllowedDomains(value) {
  const parsed = String(value || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_DOMAINS.slice();
}

function isAllowedRecipient(address, allowedDomains) {
  const match = /^[^@\s]+@([^@\s]+)$/.exec(String(address).trim());
  if (!match) return false;
  const domain = match[1].toLowerCase();
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function filterAllowedRecipients(to, allowedDomains) {
  const list = Array.isArray(to) ? to : [];
  const seen = new Set();
  const allowed = [];
  for (const raw of list) {
    const address = String(raw).trim();
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    if (isAllowedRecipient(address, allowedDomains)) allowed.push(address);
  }
  return allowed;
}

function json(context, body) {
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

module.exports = async function notify(context, req) {
  const payload = req.body || {};
  const allowedDomains = parseAllowedDomains(process.env.NOTIFY_ALLOWED_DOMAINS);

  // Optional Teams delivery. A request carrying a `teams` card targets the Teams
  // webhook instead of email. Recipients are still filtered against the domain
  // allowlist so this can never be abused as an open relay.
  if (payload && payload.teams != null) {
    const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
    if (!teamsWebhook) {
      json(context, {
        delivered: false,
        reason: 'TEAMS_WEBHOOK_URL application setting is not configured',
      });
      return;
    }
    const teamsTo = filterAllowedRecipients(payload.to, allowedDomains);
    if (teamsTo.length === 0) {
      json(context, { delivered: false, reason: 'no recipients within the allowed domains' });
      return;
    }
    try {
      const response = await fetch(teamsWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload.teams),
        signal: AbortSignal.timeout(15_000),
      });
      json(context, {
        delivered: response.ok,
        status: response.status,
        reason: response.ok ? undefined : `teams webhook returned ${response.status}`,
      });
    } catch (error) {
      json(context, { delivered: false, reason: error?.message || String(error) });
    }
    return;
  }

  const webhook = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhook) {
    json(context, {
      delivered: false,
      reason: 'NOTIFY_WEBHOOK_URL application setting is not configured',
    });
    return;
  }

  const to = filterAllowedRecipients(payload.to, allowedDomains);
  if (to.length === 0) {
    json(context, {
      delivered: false,
      reason: 'no recipients within the allowed domains',
    });
    return;
  }

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to, subject: payload.subject, html: payload.html }),
      signal: AbortSignal.timeout(15_000),
    });
    json(context, {
      delivered: response.ok,
      status: response.status,
      reason: response.ok ? undefined : `webhook returned ${response.status}`,
    });
  } catch (error) {
    json(context, { delivered: false, reason: error?.message || String(error) });
  }
};
