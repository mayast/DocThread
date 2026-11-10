const { forwardForm, GITHUB_TOKEN_URL } = require('../lib/github-oauth');

module.exports = async function oauthToken(context, req) {
  const clientId = req.body?.client_id;
  const deviceCode = req.body?.device_code;
  if (
    typeof clientId !== 'string' ||
    !clientId.trim() ||
    typeof deviceCode !== 'string' ||
    !deviceCode.trim()
  ) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { error: 'client_id_and_device_code_required' },
    };
  }
  return forwardForm(context, GITHUB_TOKEN_URL, {
    client_id: clientId.trim(),
    device_code: deviceCode.trim(),
    grant_type:
      typeof req.body?.grant_type === 'string'
        ? req.body.grant_type
        : 'urn:ietf:params:oauth:grant-type:device_code',
  });
};