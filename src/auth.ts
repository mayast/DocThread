// Unified auth for DocThread.
//
// Three modes, chosen at build time:
//   • "dev"   — local development. The Vite dev server exposes /auth/* endpoints
//               backed by the `gh` CLI, and proxies GitHub API calls via /gh-api.
//   • "oauth" — production on Azure Static Web Apps. Each visitor signs in with their
//               own GitHub account via the OAuth *device flow*, proxied through a
//               tiny CORS Worker (no client secret — device flow is a public
//               client). GitHub REST calls then go straight to api.github.com,
//               which supports CORS, using the per-user token.
//   • "static"— production without OAuth configuration. The sample and public
//               GitHub documents remain usable, but sign-in and writes are disabled.
//
// Mode is "oauth" when both VITE_GH_CLIENT_ID and VITE_OAUTH_PROXY are set.

import { parseAllowedDomains } from './notifyAllowlist.ts';

const CLIENT_ID = import.meta.env.VITE_GH_CLIENT_ID as string | undefined;
const OAUTH_PROXY = (import.meta.env.VITE_OAUTH_PROXY as string | undefined)?.replace(/\/+$/, '');
const SCOPE = 'repo read:org';

export const AUTH_MODE: 'dev' | 'oauth' | 'static' =
  CLIENT_ID && OAUTH_PROXY ? 'oauth' : import.meta.env.PROD ? 'static' : 'dev';

export const GH_API_BASE =
  AUTH_MODE !== 'dev'
    ? 'https://api.github.com'
    : typeof window !== 'undefined'
    ? `${window.location.origin}/gh-api`
    : 'https://api.github.com';

// Where @mention email notifications are POSTed ({ to, subject, html }).
//   • dev   — same-origin /api/notify (the Vite dev server forwards to NOTIFY_WEBHOOK_URL).
//   • oauth — the OAuth proxy's /notify route (forwards to its NOTIFY_WEBHOOK_URL secret),
//             so the hosted site can email without a same-origin backend.
//   • static— same-origin /api/notify (Azure Static Web Apps function), if configured.
export const NOTIFY_ENDPOINT =
  AUTH_MODE === 'oauth' && OAUTH_PROXY ? `${OAUTH_PROXY}/notify` : '/api/notify';

// Optional Microsoft Teams delivery for review notifications (#31). Opt-in: off
// by default so nothing changes for existing deployments. Set VITE_TEAMS_NOTIFY=on
// to also post a Teams card (via the same NOTIFY_ENDPOINT relay) when a mention is
// emailed. The relay only delivers when its TEAMS_WEBHOOK_URL app setting is
// configured, and always enforces the recipient domain allowlist.
export const TEAMS_NOTIFY_ENABLED =
  (import.meta.env.VITE_TEAMS_NOTIFY as string | undefined)?.toLowerCase() === 'on';

// Client-side mirror of the notify relay's recipient allow-list. Used only to
// preview which "Share for review" invitees will actually be emailed (#111); the
// relay re-applies NOTIFY_ALLOWED_DOMAINS server-side and remains authoritative,
// so this can never widen who gets contacted. Configure with
// VITE_NOTIFY_ALLOWED_DOMAINS to match the relay; defaults to the tenant domain.
export const NOTIFY_ALLOWED_DOMAINS = parseAllowedDomains(
  import.meta.env.VITE_NOTIFY_ALLOWED_DOMAINS as string | undefined
);

// Optional AI summarization endpoint for the "Summarize review" action. Opt-in
// only: unset by default, so the feature falls back to a deterministic local
// digest. Configure with VITE_SUMMARIZE_ENDPOINT to enable an AI-generated
// summary. The endpoint receives a read-only { docTitle, scope, threads } payload
// and returns { summary: string }.
export const SUMMARIZE_ENDPOINT =
  (import.meta.env.VITE_SUMMARIZE_ENDPOINT as string | undefined)?.replace(/\/+$/, '') || '';

// Optional AI endpoint for "AI: draft a fix" (#63). Opt-in only: unset by default,
// so the action degrades gracefully with a note. Configure with VITE_SUGGEST_ENDPOINT
// to enable AI-drafted suggested edits. The endpoint receives a read-only
// { original, feedback, docTitle, skill? } payload and returns { replacement: string }.
export const SUGGEST_ENDPOINT =
  (import.meta.env.VITE_SUGGEST_ENDPOINT as string | undefined)?.replace(/\/+$/, '') || '';

// Optional AI endpoint for the "Assess readiness" action (#44). Opt-in only:
// unset by default, so the score falls back to a deterministic local rubric.
// Configure with VITE_READINESS_ENDPOINT to enable an AI-graded assessment. The
// endpoint receives a read-only { docTitle, markdown, skill? } payload and returns
// { score: number, grade?: string, gaps?: [{ title, detail, severity, quote? }] }.
export const READINESS_ENDPOINT =
  (import.meta.env.VITE_READINESS_ENDPOINT as string | undefined)?.replace(/\/+$/, '') || '';

// Optional AI endpoint for the "Run AI review" pass (#43, governed by REVIEW.md #89).
// Opt-in only: unset by default, so the reviewer falls back to a deterministic local
// pass. Configure with VITE_REVIEW_ENDPOINT to enable AI-drafted findings. The
// endpoint receives a read-only { docTitle, markdown, policy, skill? } payload and returns
// { findings: [{ title, rationale, quote, intent, severity, pass, replacement? }] }.
export const REVIEW_ENDPOINT =
  (import.meta.env.VITE_REVIEW_ENDPOINT as string | undefined)?.replace(/\/+$/, '') || '';

// Optional comma/newline-separated repo paths or URLs to treat as candidate AI
// skills (#92). The first readable text/Markdown file is applied to AI review,
// readiness, and suggested-edit calls unless the reviewer selects/pastes a skill.
export const SKILL_PATHS = import.meta.env.VITE_SKILL_PATHS as string | undefined;

const TOKEN_KEY = 'docthread:gh-token';

let token: string =
  AUTH_MODE === 'oauth' && typeof localStorage !== 'undefined'
    ? localStorage.getItem(TOKEN_KEY) || ''
    : '';

export function getToken(): string {
  return token;
}

function setToken(next: string) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore storage failures */
  }
}

export interface AuthStatus {
  authenticated: boolean;
  login?: string;
  name?: string;
  nodeId?: string;
  avatarUrl?: string;
}

/** Current sign-in status for either mode. */
export async function getAuthStatus(): Promise<AuthStatus> {
  if (AUTH_MODE === 'dev') {
    const r = await fetch('/auth/status');
    const j = await r.json();
    return j.authenticated
      ? {
          authenticated: true,
          login: j.login,
          name: j.name,
          nodeId: j.nodeId,
          avatarUrl: j.avatarUrl,
        }
      : { authenticated: false };
  }
  if (AUTH_MODE === 'static') return { authenticated: false };
  // oauth: we're signed in iff we hold a token that api.github.com accepts.
  if (!token) return { authenticated: false };
  try {
    const r = await fetch(`${GH_API_BASE}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) {
      if (r.status === 401) setToken(''); // stale/revoked token
      return { authenticated: false };
    }
    const u = await r.json();
    return {
      authenticated: true,
      login: u.login,
      name: u.name,
      nodeId: u.node_id,
      avatarUrl: u.avatar_url,
    };
  } catch {
    return { authenticated: false };
  }
}

/** Sign out of the current mode. */
export async function signOut(): Promise<void> {
  if (AUTH_MODE === 'dev') {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    return;
  }
  setToken('');
}

// ---- dev mode: kick off `gh auth login --web` in a console -----------------
export interface DevLoginResult {
  started: boolean;
  authenticated: boolean;
  login?: string;
}

export async function startDevLogin(): Promise<DevLoginResult> {
  const response = await fetch('/auth/login', { method: 'POST' });
  if (!response.ok) throw new Error(`GitHub login failed (${response.status}).`);
  return response.json();
}

// ---- oauth mode: GitHub device flow ----------------------------------------

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

export function isOAuthConfigured(): boolean {
  return AUTH_MODE === 'oauth';
}

/** Step 1: request a device + user code from GitHub (via the CORS proxy). */
export async function startDeviceLogin(signal?: AbortSignal): Promise<DeviceCode> {
  if (AUTH_MODE !== 'oauth') throw new Error('Device login is only available in the hosted build.');
  const r = await fetch(`${OAUTH_PROXY}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
    signal,
  });
  if (!r.ok) throw new Error(`Device code request failed (${r.status})`);
  const j = await r.json();
  if (j.error) throw new Error(j.error_description || j.error);
  return {
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    deviceCode: j.device_code,
    interval: j.interval ?? 5,
    expiresIn: j.expires_in ?? 900,
  };
}

/**
 * Step 2: poll for the access token until the user finishes the browser step.
 * Resolves once signed in; rejects on timeout / denial. `signal` can abort it.
 */
export async function pollForDeviceToken(dc: DeviceCode, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + dc.expiresIn * 1000;
  let interval = dc.interval;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    await new Promise((res) => setTimeout(res, interval * 1000));
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    const r = await fetch(`${OAUTH_PROXY}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: dc.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal,
    });
    const j = await r.json();
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    if (j.access_token) {
      setToken(j.access_token);
      return;
    }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') {
      interval = (j.interval ?? interval) + 5;
      continue;
    }
    // access_denied, expired_token, unsupported_grant_type, etc.
    throw new Error(j.error_description || j.error || 'Authorization failed.');
  }
  throw new Error('Sign-in timed out. Please try again.');
}
