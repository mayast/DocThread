/**
 * DocThread OAuth proxy — a minimal CORS relay for the GitHub OAuth *device flow*.
 *
 * Why this exists: GitHub's device-flow endpoints
 *   POST https://github.com/login/device/code
 *   POST https://github.com/login/oauth/access_token
 * do NOT send CORS headers. This optional relay forwards those two requests and
 * adds CORS headers; the supported SWA deployment uses its managed /api routes.
 *
 * There is NO client secret here — the OAuth *device flow* is a public-client flow,
 * so the client_id (sent by the browser) is all that's needed. This Worker never
 * sees or stores any user token; it just relays the request/response.
 *
 * Routes:
 *   POST /device/code   -> https://github.com/login/device/code
 *   POST /oauth/token   -> https://github.com/login/oauth/access_token
 *
 * Configure ALLOWED_ORIGINS (comma-separated) as a Worker var. Requests without
 * an exact approved Origin are rejected; wildcard operation is not supported.
 */

const GH_DEVICE_CODE = 'https://github.com/login/device/code';
const GH_ACCESS_TOKEN = 'https://github.com/login/oauth/access_token';

function corsHeaders(origin, allowed) {
  const allowList = (allowed || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || origin === '*' || !allowList.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function relay(upstream, request, cors) {
  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch {
    /* empty body */
  }
  const upstreamRes = await fetch(upstream, {
    method: 'POST',
    headers: {
      'Content-Type': request.headers.get('Content-Type') || 'application/json',
      Accept: 'application/json',
      'User-Agent': 'DocThread-OAuth-Proxy',
    },
    body: bodyText,
  });
  const text = await upstreamRes.text();
  return new Response(text, {
    status: upstreamRes.status,
    headers: {
      'Content-Type': upstreamRes.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

async function deviceCodeRequest(request, cors) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
    });
  }
  if (typeof payload?.client_id !== 'string' || !payload.client_id.trim()) {
    return new Response(JSON.stringify({ error: 'client_id_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
    });
  }
  const body = JSON.stringify({ client_id: payload.client_id.trim(), scope: 'repo read:org' });
  return relay(
    GH_DEVICE_CODE,
    new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    cors
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env && env.ALLOWED_ORIGINS);

    if (!cors) {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Cache-Control': 'no-store', Vary: 'Origin' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...cors, 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/device/code') {
      return deviceCodeRequest(request, cors);
    }
    if (url.pathname === '/oauth/token') {
      return relay(GH_ACCESS_TOKEN, request, cors);
    }
    return new Response('Not Found', {
      status: 404,
      headers: { ...cors, 'Cache-Control': 'no-store' },
    });
  },
};
