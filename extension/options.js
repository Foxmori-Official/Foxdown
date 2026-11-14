// Foxdown Connector - 设置页 v3.1：多服务器 URL 路由 + 嗅探/外部请求开关
//   + 深度搜索 + 嗅探正则过滤 + 文件名模板 + 自动下载嗅探媒体 + 手动语言切换
// i18n() / loadI18nOverride() 由 i18n.js（<script> 先加载）提供；未加载时兜底原生 chrome.i18n
if (typeof globalThis.loadI18nOverride !== 'function') globalThis.loadI18nOverride = async () => {};
if (typeof globalThis.i18n !== 'function') globalThis.i18n = (k, s) => chrome.i18n.getMessage(k, s) || k;
const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:16801',
  apiToken: '',
  servers: [],              // [{name, url, token, pattern}]；为空时后台用 serverUrl/apiToken 构造默认项
  enabled: true,
  domainMode: 'off',        // off | blacklist | whitelist
  domainList: '',
  extMode: 'off',           // off | whitelist | blacklist
  extList: '',
  minSizeMB: 0,
  captureUnknownSize: true,
  captureMagnet: true,
  notifyComplete: true,
  sniffEnabled: true,
  allowExternalRequest: false,
  deepSearch: false,
  sniffRegexRules: [],      // [{url, state}]；界面按每行一条编辑
  fileNameTemplate: '',
  autoDownloadSniffed: false,
  autoDownloadMinSizeMB: 10,
  askBeforeDownload: false, // 下载前弹出参数确认窗口
  panelOpenStyle: 'popup'   // 管理面板打开方式：popup | newtab | window | sidepanel
};
const $ = id => document.getElementById(id);
const FIELDS = ['serverUrl', 'apiToken', 'enabled', 'domainMode', 'domainList', 'extMode', 'extList',
  'minSizeMB', 'captureUnknownSize', 'captureMagnet', 'notifyComplete', 'sniffEnabled', 'allowExternalRequest',
  'deepSearch', 'fileNameTemplate', 'autoDownloadSniffed', 'autoDownloadMinSizeMB',
  'askBeforeDownload', 'panelOpenStyle'];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// 多服务器列表 UI（Aria2-Explorer rpcList 行式编辑模式）
// ============================================================
function serverRow(s = {}) {
  const div = document.createElement('div');
  div.className = 'server-row';
  div.innerHTML =
    `<input type="text" class="srv-name" aria-label="${esc(i18n('srvColName'))}" placeholder="${esc(i18n('srvColName'))}" value="${esc(s.name || '')}">` +
    `<input type="text" class="srv-url" aria-label="${esc(i18n('srvColUrl'))}" placeholder="http://127.0.0.1:16801" value="${esc(s.url || '')}">` +
    `<input type="password" class="srv-token" aria-label="${esc(i18n('srvColToken'))}" placeholder="Token" value="${esc(s.token || '')}">` +
    `<input type="text" class="srv-pattern" aria-label="${esc(i18n('srvColPattern'))}" placeholder="*" value="${esc(s.pattern || '')}">` +
    `<button type="button" class="srv-del" title="×">×</button>`;
  div.querySelector('.srv-del').addEventListener('click', () => div.remove());
  return div;
}

function renderServers(list) {
  const wrap = $('serverList');
  wrap.innerHTML = '';
  for (const s of list || []) wrap.appendChild(serverRow(s));
}

function collectServers() {
  return [...document.querySelectorAll('#serverList .server-row')].map(r => ({
    name: r.querySelector('.srv-name').value.trim() || i18n('srvDefault'),
    url: r.querySelector('.srv-url').value.trim().replace(/\/+$/, ''),
    token: r.querySelector('.srv-token').value.trim(),
    pattern: r.querySelector('.srv-pattern').value.trim() || '*'
  })).filter(s => s.url);
}

$('addServer').addEventListener('click', () => {
  $('serverList').appendChild(serverRow());
});

async function load() {
  const s = await readSettings(DEFAULTS);
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
  }
  renderServers(Array.isArray(s.servers) ? s.servers : []);
  // 嗅探正则过滤：数组 [{url, state}] ↔ 每行一条
  $('sniffRegexRules').value = (Array.isArray(s.sniffRegexRules) ? s.sniffRegexRules : [])
    .filter(r => r && r.url && r.state !== false)
    .map(r => r.url)
    .join('\n');
}

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = ok === true ? 'ok' : ok === false ? 'err' : '';
}

function collect() {
  return {
    serverUrl: $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.serverUrl,
    apiToken: $('apiToken').value.trim(),
    servers: collectServers(),
    enabled: $('enabled').checked,
    domainMode: $('domainMode').value,
    domainList: $('domainList').value.trim(),
    extMode: $('extMode').value,
    extList: $('extList').value.trim(),
    minSizeMB: Math.max(0, Number($('minSizeMB').value) || 0),
    captureUnknownSize: $('captureUnknownSize').checked,
    captureMagnet: $('captureMagnet').checked,
    notifyComplete: $('notifyComplete').checked,
    sniffEnabled: $('sniffEnabled').checked,
    allowExternalRequest: $('allowExternalRequest').checked,
    deepSearch: $('deepSearch').checked,
    sniffRegexRules: $('sniffRegexRules').value.split('\n')
      .map(s => s.trim()).filter(Boolean)
      .map(url => ({ url, state: true })),
    fileNameTemplate: $('fileNameTemplate').value.trim(),
    autoDownloadSniffed: $('autoDownloadSniffed').checked,
    autoDownloadMinSizeMB: Math.max(0, Number($('autoDownloadMinSizeMB').value) || 0),
    askBeforeDownload: $('askBeforeDownload').checked,
    panelOpenStyle: $('panelOpenStyle').value
  };
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    const settings = collect();
    settings.serverUrl = normalizeServerUrl(settings.serverUrl);
    for (const server of settings.servers) server.url = normalizeServerUrl(server.url);
    await writeSettings(settings);
    setStatus(i18n('statusSaved'), true);
  } catch (error) {
    setStatus(i18n(error.message === 'serverAddressInvalid' ? 'serverAddressInvalid' : 'settingsSaveFailed'), false);
  } finally {
    btn.disabled = false;
  }
}

async function test() {
  const btn = $('test');
  btn.disabled = true;
  const server = preferredServer(collectServers()) || {
    url: $('serverUrl').value.trim() || DEFAULTS.serverUrl,
    token: $('apiToken').value.trim(),
  };
  setStatus(i18n('statusTesting'));
  try {
    const url = normalizeServerUrl(server.url);
    const health = await checkServerHealth(url, server.token);
    setStatus(i18n('obTestOk', health.aria2Version || i18n('versionUnknown')) + '\n' + url, true);
  } catch (error) {
    setStatus(i18n(error.message), false);
  } finally {
    btn.disabled = false;
  }
}

$('export').addEventListener('click', async () => {
  const all = await readSettings(DEFAULTS);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `foxdown-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const clean = {};
      for (const k of FIELDS) if (k in data) clean[k] = data[k];
      if (Array.isArray(data.servers)) clean.servers = data.servers;
      if (Array.isArray(data.sniffRegexRules)) clean.sniffRegexRules = data.sniffRegexRules;
      await writeSettings(clean);
      await load();
      setStatus(i18n('importSuccess'), true);
    } catch (err) { setStatus(i18n('importFailed', String(err.message || err)), false); }
  };
  reader.readAsText(f);
  e.target.value = '';
});

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);

// 二次访问入口：重新打开安装引导页（onboarding）
$('reopenGuide').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

// 应用 data-i18n / data-i18n-ph 文案与 <title>（启动与语言即时切换共用）
async function applyI18nTexts() {
  try { await loadI18nOverride(); } catch (e) {}
  if (document.documentElement) document.documentElement.lang = globalThis.getI18nLocale?.() || 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const msg = i18n(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    const msg = i18n(el.getAttribute('data-i18n-ph'));
    if (msg) el.placeholder = msg;
  }
  document.title = i18n('optTitle');
  document.dispatchEvent(new Event('foxdown-options-language'));
}

// 语言切换：即时应用，无需重载扩展（参考 Aria2-Explorer localizeHtmlPage 思路——
// 重新加载覆盖层并原地重刷全部文案；background 侧由 storage.onChanged 重建菜单/事件流）
$('locale').addEventListener('change', async (e) => {
  const locale = e.target.value || 'auto';
  await writeSettings({ locale });
  await applyI18nTexts();
  setStatus(i18n('langApplied'), true);
});

// 启动引导（普通 script 无法顶层 await，包 async IIFE）
(async () => {
  await applyI18nTexts();
  try {
    const s = await readSettings({ locale: 'auto' });
    $('locale').value = s.locale || 'auto';
  } catch (e) {}
  load();
})();
