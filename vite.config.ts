import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync, execSync, spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseAllowedDomains, filterAllowedRecipients } from './src/notifyAllowlist.ts';

// ---------------------------------------------------------------------------
// GitHub sign-in is handled by the GitHub CLI (`gh`), so the app authenticates
// as your real GitHub account — EMU/SSO included — with no token pasting and no
// OAuth app registration. The dev proxy injects the current gh token server-side
// into every GitHub API call, and /auth/* endpoints let the UI show who you are
// and launch GitHub's real web login to sign in / switch accounts.
// ---------------------------------------------------------------------------

let tokenCache = { value: '', at: 0 };
let adoTokenCache = { value: '', at: 0 };
const authorBoundTokens = new WeakMap<IncomingMessage, string>();
const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

// Run the Azure CLI cross-platform. On Windows `az` is a batch file (`az.cmd`),
// which execFileSync can't launch directly (ENOENT/EINVAL) — so run through the
// shell, which resolves `az.cmd` on Windows and `az` elsewhere. Without this the
// dev proxy gets no ADO token on Windows, every /ado-api call 302s to sign-in,
// and ADO work items silently fall back to the stored review snapshot.
function azCli(args: string[], opts: { json?: boolean } = {}): string {
  return execFileSync('az', args, {
    encoding: 'utf8',
    stdio: opts.json ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore'],
    shell: true,
  }).trim();
}
function ghToken(): string {
  // Cache briefly so we don't shell out on every proxied request, while still
  // picking up a new token soon after the user signs in or switches accounts.
  if (Date.now() - tokenCache.at < 3000) return tokenCache.value;
  let value = '';
  try {
    value = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    value = '';
  }
  tokenCache = { value, at: Date.now() };
  return value;
}

function ghUser(): {
  authenticated: boolean;
  login?: string;
  name?: string;
  nodeId?: string;
  avatarUrl?: string;
} {
  try {
    const out = execSync('gh api user', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const u = JSON.parse(out);
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

function adoToken(): string {
  if (Date.now() - adoTokenCache.at < 30_000) return adoTokenCache.value;
  let value = '';
  try {
    value = azCli([
      'account',
      'get-access-token',
      '--resource',
      ADO_RESOURCE_ID,
      '--query',
      'accessToken',
      '--output',
      'tsv',
    ]);
  } catch {
    value = '';
  }
  adoTokenCache = { value, at: Date.now() };
  return value;
}

function adoUser(): { authenticated: boolean; login?: string; name?: string } {
  if (!adoToken()) return { authenticated: false };
  try {
    const output = azCli(['account', 'show', '--output', 'json'], { json: true });
    const account = JSON.parse(output);
    const login = account.user?.name;
    return login ? { authenticated: true, login, name: login } : { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function launchGhConsole(title: string, args: string[]) {
  const child =
    process.platform === 'win32'
      ? spawn(
          'cmd.exe',
          ['/d', '/s', '/c', `start "${title}" cmd.exe /k "gh ${args.join(' ')}"`],
          { detached: true, stdio: 'ignore', windowsHide: true }
        )
      : spawn('gh', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function launchAzConsole(title: string, args: string[]) {
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `start "${title}" cmd.exe /k "az ${args.join(' ')}"`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
      : spawn('az', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function authPlugin() {
  return {
    name: 'docthread-gh-auth',
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>
        ) => void;
      };
    }) {
      // Who is currently signed in.
      server.middlewares.use('/auth/status', (_req, res) => sendJson(res, 200, ghUser()));

      // Launch GitHub's real web login in a separate console (device/web flow + SSO).
      server.middlewares.use('/auth/login', (_req, res) => {
        const current = ghUser();
        if (current.authenticated) {
          sendJson(res, 200, { started: false, ...current });
          return;
        }
        try {
          launchGhConsole('DocThread GitHub Login', [
            'auth',
            'login',
            '--web',
            '--hostname',
            'github.com',
            '--git-protocol',
            'https',
          ]);
          tokenCache = { value: '', at: 0 };
          sendJson(res, 200, { started: true, authenticated: false });
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
        }
      });

      // Sign out of the CLI (opens a console to confirm).
      server.middlewares.use('/auth/logout', (_req, res) => {
        try {
          launchGhConsole('DocThread GitHub Logout', [
            'auth',
            'logout',
            '--hostname',
            'github.com',
          ]);
          tokenCache = { value: '', at: 0 };
          sendJson(res, 200, { started: true });
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
        }
      });

      server.middlewares.use('/gh-api', async (req, res, next) => {
        const expected = req.headers['x-docthread-viewer-node-id'];
        if (typeof expected === 'string') {
          const token = ghToken();
          if (!token) {
            sendJson(res, 401, { error: 'github_signin_required' });
            return;
          }
          try {
            const viewerResponse = await fetch('https://api.github.com/user', {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
              },
            });
            const viewer = await viewerResponse.json();
            if (!viewerResponse.ok || viewer.node_id !== expected) {
              sendJson(res, 409, {
                error: 'github_account_changed',
                message:
                  'The active GitHub CLI account no longer matches the persisted comment author.',
              });
              return;
            }
            authorBoundTokens.set(req, token);
          } catch (error) {
            sendJson(res, 502, { error: 'github_identity_check_failed', message: String(error) });
            return;
          }
        }
        next();
      });

      server.middlewares.use('/ado-auth/status', (_req, res) => sendJson(res, 200, adoUser()));

      server.middlewares.use('/ado-auth/login', (_req, res) => {
        const current = adoUser();
        if (current.authenticated) {
          sendJson(res, 200, { started: false, ...current });
          return;
        }
        try {
          launchAzConsole('DocThread Azure Login', ['login']);
          adoTokenCache = { value: '', at: 0 };
          sendJson(res, 200, { started: true, authenticated: false });
        } catch (error) {
          sendJson(res, 500, { error: String((error as Error)?.message ?? error) });
        }
      });

      server.middlewares.use('/ado-auth/logout', (_req, res) => {
        try {
          azCli(['logout']);
          adoTokenCache = { value: '', at: 0 };
          sendJson(res, 200, { started: false, authenticated: false });
        } catch (error) {
          sendJson(res, 500, { error: String((error as Error)?.message ?? error) });
        }
      });

      // @mention email notifications. The client POSTs { to, subject, html } here
      // when someone is mentioned; we forward it server-side to NOTIFY_WEBHOOK_URL
      // (an Azure Logic App "When a HTTP request is received" trigger that sends an
      // Outlook email). Keeping the flow URL server-side avoids exposing it in the
      // client bundle and sidesteps browser CORS. Recipients are filtered against
      // a domain allowlist (NOTIFY_ALLOWED_DOMAINS) so this is never an open relay.
      server.middlewares.use('/api/notify', (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { delivered: false, reason: 'POST only' });
          return;
        }
        let data = '';
        req.on('data', (c: Buffer) => (data += c));
        req.on('end', async () => {
          let payload: { to?: unknown; subject?: unknown; html?: unknown; teams?: unknown };
          try {
            payload = JSON.parse(data || '{}');
          } catch {
            sendJson(res, 400, { delivered: false, reason: 'invalid JSON body' });
            return;
          }
          const allowedDomains = parseAllowedDomains(process.env.NOTIFY_ALLOWED_DOMAINS);

          // Optional Teams delivery — same allowlist, separate webhook target.
          if (payload.teams != null) {
            const teamsWebhook = process.env.TEAMS_WEBHOOK_URL;
            if (!teamsWebhook) {
              sendJson(res, 200, {
                delivered: false,
                reason: 'TEAMS_WEBHOOK_URL is not set — see README “Teams notifications”.',
              });
              return;
            }
            const teamsTo = filterAllowedRecipients(payload.to, allowedDomains);
            if (teamsTo.length === 0) {
              sendJson(res, 200, {
                delivered: false,
                reason: 'no recipients within the allowed domains',
              });
              return;
            }
            try {
              const upstream = await fetch(teamsWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload.teams),
              });
              const text = await upstream.text();
              sendJson(res, upstream.ok ? 200 : 502, {
                delivered: upstream.ok,
                status: upstream.status,
                reason: upstream.ok ? undefined : text.slice(0, 300),
              });
            } catch (e) {
              sendJson(res, 502, { delivered: false, reason: String((e as Error)?.message ?? e) });
            }
            return;
          }

          const webhook = process.env.NOTIFY_WEBHOOK_URL;
          if (!webhook) {
            sendJson(res, 200, {
              delivered: false,
              reason: 'NOTIFY_WEBHOOK_URL is not set — see README “@mention email notifications”.',
            });
            return;
          }
          const to = filterAllowedRecipients(payload.to, allowedDomains);
          if (to.length === 0) {
            sendJson(res, 200, {
              delivered: false,
              reason: 'no recipients within the allowed domains',
            });
            return;
          }
          try {
            const upstream = await fetch(webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to, subject: payload.subject, html: payload.html }),
            });
            const text = await upstream.text();
            sendJson(res, upstream.ok ? 200 : 502, {
              delivered: upstream.ok,
              status: upstream.status,
              reason: upstream.ok ? undefined : text.slice(0, 300),
            });
          } catch (e) {
            sendJson(res, 502, { delivered: false, reason: String((e as Error)?.message ?? e) });
          }
        });
      });
    },
  };
}

const OS_ENV_KEYS = new Set(Object.keys(process.env));

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), '');
  for (const [name, value] of Object.entries(fileEnvironment)) {
    if (value && !OS_ENV_KEYS.has(name)) process.env[name] = value;
  }

  const graphTransport = (process.env.VITE_GRAPH_TRANSPORT || 'off').toLowerCase();
  const adoTransport = (process.env.VITE_ADO_TRANSPORT || 'off').toLowerCase();
  if (mode === 'production') {
    if (graphTransport === 'msal') {
      if (!process.env.VITE_AZURE_CLIENT_ID) {
        throw new Error('VITE_GRAPH_TRANSPORT=msal requires VITE_AZURE_CLIENT_ID.');
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        process.env.VITE_AZURE_TENANT_ID || ''
      )) {
        throw new Error('Graph MSAL builds require an explicit tenant GUID.');
      }
    }
    if (adoTransport !== 'off') {
      throw new Error('Hosted Azure DevOps transport is disabled until issue #15 is implemented.');
    }
  }
  console.info(
    `[DocThread capabilities] github=${process.env.VITE_GH_CLIENT_ID ? 'device-flow/direct' : 'public-only'} graph=${graphTransport} ado=${adoTransport}`
  );

  return {
  // Default to a RELATIVE base ('./') so a built bundle boots no matter what
  // path it is served from — domain root OR a sub-path. This prevents the
  // "base path mismatch" blank-page failure (issue #103), where an index.html
  // built for one base is served from another and every /assets/* request 404s.
  // Routing is query-param based (?thread=…), so a relative base is safe.
  // Hosted targets that serve at the domain root (Azure SWA and the SWA
  // pipeline) set VITE_BASE=/ explicitly and are unaffected by this default.
  base: process.env.VITE_BASE || './',
  plugins: [react(), authPlugin()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/gh-api': {
        target: 'https://api.github.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/gh-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Authenticate every GitHub API call as the signed-in gh account
            // (SSO'd for EMU orgs). Read the token dynamically so a fresh login
            // takes effect without restarting the dev server.
            const t = authorBoundTokens.get(req) || ghToken();
            if (t) proxyReq.setHeader('authorization', `Bearer ${t}`);
            proxyReq.removeHeader('x-docthread-viewer-node-id');
          });
        },
      },
      '/ado-api': {
        target: 'https://dev.azure.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/ado-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const token = adoToken();
            if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
          });
        },
      },
    },
  },
  };
});
