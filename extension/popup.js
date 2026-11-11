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
  const s = await chrome.storage.sync.get({ enabled: true });
  $('capture').checked = !!s.enabled;
}

$('capture').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  chrome.runtime.sendMessage({ type: 'capture-toggled', enabled: e.target.checked }).catch(() => {});
});

let statsInFlight = false;
async function load() {
  if (statsInFlight) return;
  statsInFlight = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const s = await chrome.storage.sync.get({
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
// 直链 mp4/mp3 等：直接 src（popup 页面发起的请求无法携带捕获的 Referer，失败则提示）
// m3u8：本地打包的 hls.js（vendor/hls.min.js，符合商店政策，禁止 CDN）
// ============================================================
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav']);
let hlsInst = null;
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
    const m = new URL(url).pathname.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

function closePreview() {
  previewGeneration += 1;
  try { hlsInst?.destroy(); } catch {}
  hlsInst = null;
  $('previewPlayer').innerHTML = '';
  $('previewBox').style.display = 'none';
  $('previewErr').style.display = 'none';
}

function previewFail(msg) {
  const err = $('previewErr');
  err.textContent = msg || i18n('previewFailed');
  err.style.display = '';
}

async function previewMedia(m) {
  closePreview();
  const generation = previewGeneration;
  const box = $('previewBox');
  $('previewName').textContent = m.filename || m.url;
  $('previewName').title = m.url;
  box.style.display = '';
  const ext = extOf(m.url);
  const isHls = ext === 'm3u8' || m.type === 'HLS';
  const isDash = ext === 'mpd' || m.type === 'DASH';
  if (isDash) { previewFail(i18n('previewUnsupported')); return; }
  const isAudio = AUDIO_EXTS.has(ext);
  if (!isHls && !isAudio && !VIDEO_EXTS.has(ext)) { previewFail(i18n('previewUnsupported')); return; }

  const player = document.createElement(isAudio ? 'audio' : 'video');
  player.controls = true;
  player.addEventListener('error', () => previewFail(i18n('previewFailed')));
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
async function loadMedia() {
  if (mediaInFlight) return;
  mediaInFlight = true;
  try {
    const s = await chrome.storage.sync.get({ sniffEnabled: true });
    if (!s.sniffEnabled) { $('mediaBox').style.display = 'none'; $('deepSearch').style.display = 'none'; return; }
    $('deepSearch').style.display = '';
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
    if (!tab?.id) return;
    let list = [];
    try { list = await chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId: tab.id }) || []; } catch {}
    const box = $('mediaBox');
    if (!list.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    $('mediaHead').textContent = `${i18n('mediaTitle')} (${list.length})`;
    const wrap = $('mediaList');
    wrap.innerHTML = '';
    // 最新嗅探到的排前面，最多展示 20 条
    for (const m of list.slice(-20).reverse()) {
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
      pv.addEventListener('click', () => previewMedia(m));
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

// 深度搜索按钮：向当前 tab 的内容脚本发消息执行页面主上下文扫描
$('deepSearch').addEventListener('click', async () => {
  const btn = $('deepSearch');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.runtime.sendMessage({ type: 'triggerDeepSearch', tabId: tab.id });
  } catch {}
  // 扫描与回传是异步的，稍后刷新媒体列表
  setTimeout(() => { loadMedia(); btn.disabled = false; btn.textContent = orig; }, 1200);
});

$('open').addEventListener('click', async () => {
  const s = await chrome.storage.sync.get({ serverUrl: 'http://127.0.0.1:16801', apiToken: '', servers: [] });
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
chrome.storage.onChanged.addListener((changes) => {
  if (changes.locale) applyI18nTexts();
});

// 启动引导（普通 script 无法顶层 await，包 async IIFE）：
// 先加载语言覆盖层 → 应用 data-i18n 文案（含主界面与下载前确认表单）→ 按模式初始化
(async () => {
  await applyI18nTexts();
  const qs = new URLSearchParams(location.search);
  if (qs.get('mode') === 'confirm') {
    initConfirmMode(qs.get('token') || '');
  } else {
    loadCfg();
    load();
    loadMedia();
    const timer = setInterval(() => { if (!document.hidden) { load(); loadMedia(); } }, 2000);
    window.addEventListener('unload', () => clearInterval(timer));
  }
})();
