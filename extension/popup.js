// Foxdown Connector - 弹窗 v3.2：接管开关 + 统计轮询（默认服务器）+ 本页嗅探媒体 + 深度搜索 + 媒体预览
//   + 下载前确认模式（?mode=confirm&token=xxx：文件名/分片/目标服务器确认表单）
// i18n() / loadI18nOverride() 由 i18n.js（<script> 先加载）提供；未加载时兜底原生 chrome.i18n
if (typeof globalThis.loadI18nOverride !== 'function') globalThis.loadI18nOverride = async () => {};
if (typeof globalThis.i18n !== 'function') globalThis.i18n = (k, s) => chrome.i18n.getMessage(k, s) || k;
const $ = id => document.getElementById(id);

function fmt(bytes) {
  if (!bytes || bytes <= 0) return '0 B/s';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}

// 默认服务器：servers 列表中 pattern 为 '*'（或空）的项，否则第一项；列表为空回退旧版单服务器字段
function pickDefaultServer(s) {
  if (Array.isArray(s.servers) && s.servers.length) {
    const list = s.servers.filter(x => x && x.url);
    if (list.length) {
      const d = list.find(x => !(x.pattern || '').trim() || x.pattern.trim() === '*');
      return d || list[0];
    }
  }
  return { name: '', url: s.serverUrl, token: s.apiToken, pattern: '*' };
}

async function loadCfg() {
  const s = await readSettings({ enabled: true });
  $('capture').checked = !!s.enabled;
}

$('capture').addEventListener('change', async (e) => {
  await writeSettings({ enabled: e.target.checked });
  chrome.runtime.sendMessage({ type: 'capture-toggled', enabled: e.target.checked }).catch(() => {});
});

let statsInFlight = false;
async function load() {
  if (statsInFlight) return;
  statsInFlight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const s = await readSettings({
      serverUrl: 'http://127.0.0.1:16801', apiToken: '', servers: []
    });
    const srv = pickDefaultServer(s);
    const base = srv.url.replace(/\/+$/, '');
    const h = {};
    if (srv.token) h['Authorization'] = 'Bearer ' + srv.token;
    const res = await fetch(base + '/api/v1/stats', { headers: h, signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Keep the timeout alive while consuming the body as well as the headers.
    const j = await res.json();
    $('active').textContent = j.numActive ?? 0;
    $('waiting').textContent = j.numWaiting ?? 0;
    $('speed').textContent = fmt(j.downloadSpeed);
    $('upspeed').textContent = fmt(j.uploadSpeed);
    $('state').textContent = i18n('stateConnected', base + (srv.name ? `（${srv.name}）` : ''));
    $('state').style.color = '';
  } catch (e) {
    $('state').textContent = i18n('stateFailed', String(e.message || e));
    $('state').style.color = '#dc2626';
  } finally {
    clearTimeout(timeout);
    statsInFlight = false;
  }
}

// ============================================================
// 媒体预览（popup 内嵌播放器）
// 直链 mp4/mp3：直接 src；按需为预览复用嗅探到的 Referer。
// m3u8：本地打包的 hls.js（vendor/hls.min.js，符合商店政策，禁止 CDN）
// ============================================================
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav']);
let hlsInst = null;
let previewPort = null;
let previewGeneration = 0;
let hlsScriptPromise = null;
function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve();
  if (!hlsScriptPromise) hlsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('vendor/hls.min.js');
    script.onload = () => {
      if (window.Hls) resolve();
      else { hlsScriptPromise = null; script.remove(); reject(new Error('HLS player unavailable')); }
    };
    script.onerror = () => { hlsScriptPromise = null; script.remove(); reject(new Error('HLS player unavailable')); };
    document.head.appendChild(script);
  });
  return hlsScriptPromise;
}

function extOf(url) {
  try {
    const m = new URL(url, 'https://foxdown.invalid').pathname.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

function closePreview() {
  previewGeneration += 1;
  previewPort?.disconnect();
  previewPort = null;
  try { hlsInst?.destroy(); } catch {}
  hlsInst = null;
  $('previewPlayer').innerHTML = '';
  $('previewBox').style.display = 'none';
  $('previewErr').style.display = 'none';
}
$('previewClose')?.addEventListener('click', closePreview);
window.addEventListener('pagehide', closePreview);

function previewFail(msg) {
  const err = $('previewErr');
  err.textContent = msg || i18n('previewFailed');
  err.style.display = 'block';
}

async function previewMedia(m, tabId) {
  closePreview();
  const generation = previewGeneration;
  const box = $('previewBox');
  $('previewName').textContent = m.filename || m.url;
  $('previewName').title = m.url;
  box.style.display = 'block';
  const ext = extOf(m.filename) || extOf(m.url);
  const isHls = ext === 'm3u8' || m.type === 'HLS';
  const isDash = ext === 'mpd' || m.type === 'DASH';
  if (isDash) { previewFail(i18n('previewUnsupported')); return; }
  const isAudio = AUDIO_EXTS.has(ext);
  if (!isHls && !isAudio && !VIDEO_EXTS.has(ext)) { previewFail(i18n('previewUnsupported')); return; }

  if (tabId != null && m.source === 'network' && m.headers?.referer) {
    try {
      const port = previewPort = chrome.runtime.connect({ name: 'foxdown-media-preview' });
      await new Promise(resolve => {
        port.onMessage.addListener(resolve);
        port.onDisconnect.addListener(resolve);
        port.postMessage({ tabId, url: m.url });
      });
    } catch {}
    if (generation !== previewGeneration) return;
  }

  const player = document.createElement(isAudio ? 'audio' : 'video');
  player.controls = true;
  player.addEventListener('error', () => {
    if (generation === previewGeneration) previewFail(i18n('previewFailed'));
  });
  $('previewPlayer').appendChild(player);

  if (isHls) {
    if (!window.Hls && player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = m.url;
      player.play().catch(() => {});
      return;
    }
    try { await loadHlsLibrary(); } catch { if (generation === previewGeneration) previewFail(i18n('previewFailed')); return; }
    if (generation !== previewGeneration) return;
    if (window.Hls && Hls.isSupported()) {
      hlsInst = new Hls();
      hlsInst.on(Hls.Events.ERROR, (_e, data) => {
        if (generation === previewGeneration && data?.fatal) previewFail(i18n('previewFailed'));
      });
      hlsInst.loadSource(m.url);
      hlsInst.attachMedia(player);
    } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = m.url; // Safari 原生 HLS
    } else {
      previewFail(i18n('previewFailed'));
      return;
    }
  } else {
    player.src = m.url;
  }
  player.play().catch(() => {});
}

// ============================================================
// 本页媒体（background 嗅探结果 + 深度搜索结果）
// ============================================================
let mediaInFlight = false;
async function resourceTab() {
  const requested = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isSafeInteger(requested) && requested > 0) {
    try {
      const tab = await chrome.tabs.get(requested);
      return /^https?:/i.test(tab.url || '') ? tab : undefined;
    } catch { return undefined; }
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const pages = tabs.filter(tab => /^https?:/i.test(tab.url || ''));
  return pages.find(tab => tab.active) || pages.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

$('sniffCapture')?.addEventListener('change', async event => {
  await writeSettings({ sniffEnabled: event.target.checked });
  await loadMedia();
});

async function loadMedia() {
  if (mediaInFlight) return;
  mediaInFlight = true;
  try {
    const s = await readSettings({ sniffEnabled: true });
    $('mediaBox').style.display = '';
    $('sniffCapture').checked = s.sniffEnabled;
    $('mediaList').innerHTML = '';
    $('mediaHead').textContent = i18n('mediaTitle');
    $('mediaEmpty').hidden = false;
    if (!s.sniffEnabled) {
      $('mediaEmpty').textContent = i18n('sniffDisabled');
      $('deepSearch').style.display = 'none';
      return;
    }
    $('deepSearch').style.display = '';
    let tab;
    try { tab = await resourceTab(); } catch {}
    $('mediaPage').textContent = tab?.title || tab?.url || '';
    $('mediaPage').title = tab?.url || '';
    if (!tab?.id) { $('mediaEmpty').textContent = i18n('sniffNoPage'); return; }
    let list = [];
    try { list = await chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId: tab.id }) || []; } catch {}
    const box = $('mediaBox');
    if (!list.length) { $('mediaEmpty').textContent = i18n('sniffEmpty'); return; }
    box.style.display = '';
    $('mediaEmpty').hidden = true;
    $('mediaHead').textContent = `${i18n('mediaTitle')} (${list.length})`;
    const wrap = $('mediaList');
    wrap.innerHTML = '';
    for (const m of [...list].reverse()) {
      const row = document.createElement('div');
      row.className = 'media-item';
      const tag = document.createElement('span');
      tag.className = 'mtag';
      tag.textContent = (m.source === 'deepSearch' ? '🔍' : '') + (m.type || 'MEDIA');
      const name = document.createElement('span');
      name.className = 'mname';
      name.textContent = m.filename || m.url;
      name.title = m.url;
      const size = document.createElement('span');
      size.className = 'msize';
      size.textContent = fmtSize(m.size);
      const pv = document.createElement('button');
      pv.className = 'mpv';
      pv.textContent = i18n('mediaPreview');
      pv.title = m.url;
      const ext = extOf(m.filename) || extOf(m.url);
      pv.disabled = !VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext) && m.type !== 'HLS';
      pv.addEventListener('click', () => previewMedia(m, tab.id));
      const btn = document.createElement('button');
      btn.className = 'mdl';
      btn.textContent = i18n('mediaDownload');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await chrome.runtime.sendMessage({ type: 'downloadSniffed', tabId: tab.id, url: m.url });
          btn.textContent = r?.ok ? '✓' : '✗';
        } catch { btn.textContent = '✗'; }
      });
      row.append(tag, name, size, pv, btn);
      wrap.appendChild(row);
    }
  } catch { /* Storage may be unavailable while an extension context closes. */ }
  finally { mediaInFlight = false; }
}

// 深度搜索按钮：在当前 tab 执行扫描并刷新媒体列表
$('deepSearch').addEventListener('click', async () => {
  const btn = $('deepSearch');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '…';
  try {
    const tab = await resourceTab();
    if (tab?.id) await chrome.runtime.sendMessage({ type: 'triggerDeepSearch', tabId: tab.id });
    await loadMedia();
  } catch {}
  finally { btn.disabled = false; btn.textContent = orig; }
});

async function loadTaskStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getDownloadStatus' });
    if (!status || !Array.isArray(status.errors)) return;
    if (Number.isFinite(status.active)) $('active').textContent = status.active;
    if (Number.isFinite(status.waiting)) $('waiting').textContent = status.waiting;
    const errors = [...status.errors];
    if (status.handoffFailure) errors.unshift({ name: status.handoffFailure.name, error: i18n('handoffFailed') + ' · ' + status.handoffFailure.error });
    if (status.unavailable) errors.push({ name: i18n('dashboardUnavailable'), error: '' });
    $('taskErrors').hidden = errors.length === 0;
    $('taskErrorTitle').textContent = i18n('downloadErrors', String(errors.length));
    $('clearHandoffError').hidden = !status.handoffFailure;
    const list = $('taskErrorList');
    list.innerHTML = '';
    for (const error of errors.slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = error.name + (error.error ? ' · ' + error.error : '');
      list.appendChild(item);
    }
  } catch {}
}
$('clearHandoffError')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearHandoffError' });
  await loadTaskStatus();
});

$('open').addEventListener('click', async () => {
  const s = await readSettings({ serverUrl: 'http://127.0.0.1:16801', apiToken: '', servers: [] });
  chrome.tabs.create({ url: pickDefaultServer(s).url.replace(/\/+$/, '') });
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
// 二次访问入口：重新打开安装引导页
$('guide').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

// ============================================================
// 下载前确认模式（Aria2-Explorer askBeforeDownload 流程的 UI 侧）：
// background 下载接管 pause 后弹本页（?mode=confirm&token=xxx），
// 拉取待确认任务渲染表单；[开始下载] 发送并取消浏览器下载，[取消] 恢复浏览器下载
// ============================================================
async function initConfirmMode(token) {
  document.body.classList.add('confirm-mode');
  let data = null;
  try { data = await chrome.runtime.sendMessage({ type: 'getPendingConfirm', token }); } catch (e) { data = { error: String(e?.message || e) }; }
  if (!data || data.error) {
    $('cfState').textContent = i18n('confirmMissing');
    $('cfStart').disabled = true;
  } else {
    $('cfName').value = data.filename || '';
    $('cfReferer').value = data.referer || '';
    const sel = $('cfServer');
    sel.innerHTML = '';
    (data.servers || []).forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = (s.name ? s.name + ' — ' : '') + s.url;
      sel.appendChild(opt);
    });
    sel.selectedIndex = data.matchedIndex >= 0 ? data.matchedIndex : 0;
  }
  $('cfStart').addEventListener('click', async () => {
    const btn = $('cfStart');
    btn.disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'confirmDownload', token,
        filename: $('cfName').value.trim(),
        split: Number($('cfSplit').value) || 0,
        serverIndex: Math.max(0, $('cfServer').selectedIndex)
      });
      if (r?.ok) { window.close(); return; }
      $('cfState').textContent = r?.error || i18n('sendFailed');
      btn.disabled = false;
    } catch (e) {
      $('cfState').textContent = String(e?.message || e);
      btn.disabled = false;
    }
  });
  $('cfCancel').addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'cancelPendingDownload', token }); } catch {}
    window.close();
  });
}

async function initBatchMode(token) {
  document.body.classList.add('batch-mode');
  const start = $('batchStart');
  const filter = $('batchFilter');
  const selectAll = $('batchAll');
  const list = $('batchList');
  const state = $('batchState');
  $('batchCancel').addEventListener('click', () => window.close());

  const data = await chrome.runtime.sendMessage({ type: 'getPendingConfirm', token }).catch(() => null);
  if (!data?.urls?.length) {
    state.textContent = i18n('confirmMissing');
    selectAll.disabled = true;
    return;
  }
  const rows = data.urls.map(url => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = url;
    label.append(checkbox, text);
    list.appendChild(label);
    return { url, label, checkbox, sent: false };
  });
  let busy = false;
  function update() {
    const query = filter.value.trim().toLowerCase();
    for (const row of rows) {
      row.label.hidden = row.sent || !row.url.toLowerCase().includes(query);
      row.checkbox.disabled = busy;
    }
    const visible = rows.filter(row => !row.label.hidden);
    selectAll.disabled = busy || !visible.length;
    selectAll.checked = Boolean(visible.length) && visible.every(row => row.checkbox.checked);
    selectAll.indeterminate = !selectAll.checked && visible.some(row => row.checkbox.checked);
    start.disabled = busy || !visible.some(row => row.checkbox.checked);
  }
  filter.addEventListener('input', update);
  list.addEventListener('change', update);
  selectAll.addEventListener('change', () => {
    for (const row of rows) if (!row.label.hidden) row.checkbox.checked = selectAll.checked;
    update();
  });
  start.addEventListener('click', async () => {
    const selected = rows.filter(row => !row.label.hidden && row.checkbox.checked);
    busy = true;
    filter.disabled = true;
    update();
    let ok = 0;
    try {
      for (let i = 0; i < selected.length; i += 5) {
        const chunk = selected.slice(i, i + 5);
        const result = await chrome.runtime.sendMessage({ type: 'submitPageLinks', token, urls: chunk.map(row => row.url) });
        if (!result?.sent) throw new Error(result?.error || i18n('sendFailed'));
        for (const row of chunk) if (result.sent.includes(row.url)) { row.sent = true; ok++; }
        const failed = Math.min(i + chunk.length, selected.length) - ok;
        state.textContent = i18n('batchResult', [String(ok), failed ? i18n('batchResultFail', String(failed)) : '']);
        update();
      }
    } catch (error) {
      state.textContent = String(error.message || error);
    } finally {
      busy = false;
      filter.disabled = false;
      update();
    }
  });
  update();
}

// 应用 data-i18n 文案（启动与语言即时切换共用）
async function applyI18nTexts() {
  try { await loadI18nOverride(); } catch (e) {}
  if (document.documentElement) document.documentElement.lang = globalThis.getI18nLocale?.() || 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const msg = i18n(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  }
}

// 语言在选项页切换后，若 popup 正开着则即时重刷（不重载扩展）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.locale) applyI18nTexts();
  if (changes.enabled) $('capture').checked = changes.enabled.newValue !== false;
  if (changes.sniffEnabled) void loadMedia();
});

// 启动引导（普通 script 无法顶层 await，包 async IIFE）：
// 先加载语言覆盖层 → 应用 data-i18n 文案（含主界面与下载前确认表单）→ 按模式初始化
(async () => {
  await applyI18nTexts();
  const qs = new URLSearchParams(location.search);
  if (qs.get('mode') === 'confirm') {
    initConfirmMode(qs.get('token') || '');
  } else if (qs.get('mode') === 'batch') {
    initBatchMode(qs.get('token') || '');
  } else {
    loadCfg();
    load();
    loadMedia();
    loadTaskStatus();
    const timer = setInterval(() => { if (!document.hidden) { load(); loadMedia(); loadTaskStatus(); } }, 2000);
    window.addEventListener('unload', () => clearInterval(timer));
  }
})();
