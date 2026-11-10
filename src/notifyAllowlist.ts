// Recipient domain allowlist for the @mention email relay.
//
// The notify relay ( /api/notify — dev middleware and the Azure Static Web Apps
// function) forwards { to, subject, html } to the Outlook Logic App. To keep it
// from being abused as an open relay that can email arbitrary external
// addresses, every recipient is filtered against an allowlist of domains before
// forwarding. Configure it with the NOTIFY_ALLOWED_DOMAINS environment variable
// (comma-separated, e.g. "microsoft.com,contoso.com"). When unset it defaults to
// the project's own tenant domain so the feature keeps working safely.
export const DEFAULT_ALLOWED_DOMAINS = ['microsoft.com'];

/** Parse the NOTIFY_ALLOWED_DOMAINS env value into a normalized domain list. */
export function parseAllowedDomains(value: string | undefined | null): string[] {
  const parsed = (value || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_DOMAINS];
}

/** True when the address's domain is within the allowlist. */
export function isAllowedRecipient(address: string, allowedDomains: string[]): boolean {
  const match = /^[^@\s]+@([^@\s]+)$/.exec(String(address).trim());
  if (!match) return false;
  const domain = match[1].toLowerCase();
  return allowedDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

/** Keep only recipients whose domain is allowed (deduped, trimmed). */
export function filterAllowedRecipients(
  to: unknown,
  allowedDomains: string[]
): string[] {
  const list = Array.isArray(to) ? to : [];
  const seen = new Set<string>();
  const allowed: string[] = [];
  for (const raw of list) {
    const address = String(raw).trim();
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    if (isAllowedRecipient(address, allowedDomains)) allowed.push(address);
  }
  return allowed;
}
