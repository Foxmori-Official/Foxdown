// The dashboard follows the saved default server used by the extension.
(() => {
  const element = id => document.getElementById(id);
  let busy = false;
  let controller;
  let serverUrl;

  function speed(value) {
    let number = Math.max(0, Number(value) || 0);
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let unit = 0;
    while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
    return number.toFixed(unit && number < 100 ? 1 : 0) + ' ' + units[unit];
  }

  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const settings = await readSettings({ serverUrl: 'http://127.0.0.1:16801', apiToken: '', servers: [] });
      const server = preferredServer(settings.servers) || { url: settings.serverUrl, token: settings.apiToken };
      serverUrl = normalizeServerUrl(server.url);
      element('dashboardServer').textContent = serverUrl;
      const response = await fetch(serverUrl + '/api/v1/stats', {
        headers: server.token ? { Authorization: 'Bearer ' + server.token } : {},
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const stats = await response.json();
      if (!Number.isFinite(Number(stats.numActive))) throw new Error('Invalid stats response');
      element('dashboardConnection').textContent = i18n('dashboardConnected');
      element('dashboardDot').classList.add('online');
      element('dashboardDownload').textContent = speed(stats.downloadSpeed);
      element('dashboardUpload').textContent = speed(stats.uploadSpeed);
      element('dashboardActive').textContent = Number(stats.numActive);
      element('dashboardWaiting').textContent = Number(stats.numWaiting) || 0;
    } catch {
      element('dashboardConnection').textContent = i18n('dashboardUnavailable');
      element('dashboardDot').classList.remove('online');
      for (const id of ['dashboardDownload', 'dashboardUpload', 'dashboardActive', 'dashboardWaiting']) element(id).textContent = '—';
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  }

  element('dashboardOpen').addEventListener('click', () => {
    if (serverUrl) chrome.tabs.create({ url: serverUrl });
  });
  element('dashboardResources').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const pages = tabs.filter(tab => /^https?:/i.test(tab.url || ''));
    const page = pages.find(tab => tab.active) || pages.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html') + (page ? '?tabId=' + page.id : ''),
      type: 'popup', width: 380, height: 680,
    });
  });
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void refresh(); });
  document.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 3000);
  window.addEventListener('pagehide', () => { clearInterval(timer); controller?.abort(); });
  void loadI18nOverride().then(refresh).catch(refresh);
})();
