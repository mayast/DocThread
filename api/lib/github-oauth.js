const GITHUB_DEVICE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

async function forwardForm(context, url, fields) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'DocThread',
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: 'invalid_upstream_response' };
    }
    return {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body,
    };
  } catch (error) {
    context.log.error('GitHub OAuth relay failed', error?.message || String(error));
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { error: 'oauth_relay_unavailable' },
    };
  }
}

module.exports = { forwardForm, GITHUB_DEVICE_URL, GITHUB_TOKEN_URL };