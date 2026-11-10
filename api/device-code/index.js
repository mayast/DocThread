const { forwardForm, GITHUB_DEVICE_URL } = require('../lib/github-oauth');

module.exports = async function deviceCode(context, req) {
  const clientId = req.body?.client_id;
  if (typeof clientId !== 'string' || !clientId.trim()) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { error: 'client_id_required' },
    };
  }
  return forwardForm(context, GITHUB_DEVICE_URL, {
    client_id: clientId.trim(),
    scope: 'repo read:org',
  });
};