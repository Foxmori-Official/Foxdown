// Shared by the setup guide and settings page.
function normalizeServerUrl(value) {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error('serverAddressInvalid');
  }
}

function preferredServer(servers) {
  const entries = Array.isArray(servers) ? servers.filter(server => server?.url) : [];
  return entries.find(server => ['', '*'].includes(String(server.pattern || '').trim())) || entries[0];
}

async function checkServerHealth(url, token) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let response;
  try {
    response = await fetch(url + '/api/v1/health', {
      headers, signal: AbortSignal.timeout(6000), redirect: 'error',
    });
  } catch {
    throw new Error('obTestFail');
  }
  if (response.status === 401 || response.status === 403) throw new Error('serverTokenInvalid');
  if (!response.ok) throw new Error('obTestFail');

  const health = await response.json().catch(() => null);
  if (health?.ok !== true || !['foxdown', 'rdown'].includes(health.app)) throw new Error('serverNotFoxdown');
  if (!health.aria2) throw new Error('serverEngineUnavailable');
  return health;
}
