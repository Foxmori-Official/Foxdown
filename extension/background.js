// Foxdown Connector - 后台服务脚本 v3.1
// v2.0: 融合 Aria2-Explorer（cookies API 兜底、过滤优先级、Alt 旁路、磁力点击拦截）
//       与 Gopeed browser-extension（webRequest 精确请求头捕获、pause→cancel/resume 接管流程）的优点
// v3.0 新增：
//   1) 网页流媒体嗅探（参考 cat-catch：onResponseStarted + onSendHeaders 按 requestId 配对 + onErrorOccurred 清理）
//   2) 多服务器 URL 路由（参考 Aria2-Explorer getRpcServer/rpcList 模式）
//   3) 第三方扩展中间件 API（参考 Aria2-Explorer externally_connectable + onMessageExternal 模式）
// v3.1 新增（融合 cat-catch 核心能力）：
//   1) 深度搜索 deepSearch（内容脚本注入页面主上下文扫描 script 文本/播放器全局变量）
//   2) 嗅探正则过滤 sniffRegexRules（cat-catch init.js wildcardToRegex 方案）
//   3) 文件名模板 fileNameTemplate（cat-catch templates.js 变量体系精简版）
//   4) 自动下载嗅探媒体 autoDownloadSniffed + 体积阈值（Set 防重复）
// v3.2 新增（参考 Aria2-Explorer askBeforeDownload + webUIOpenStyle）：
//   1) 下载前参数确认弹窗 askBeforeDownload：pause 后挂起浏览器下载，
//      弹 popup.html?mode=confirm 确认文件名/分片/目标服务器，确认发送、取消恢复
//   2) 管理面板多形态 panelOpenStyle：popup/newtab/window/sidepanel，
//      非 popup 形态运行时 chrome.action.setPopup({popup:''}) 清空，图标点击走 onClicked 分发

// 共享纯函数（lib.js）：wildcardToRegex / matchSniffRegexRules /
// renderFileNameTemplate / shouldAutoDownload / deepSearchScanSource
// 手动语言切换覆盖层（i18n.js）：全局 i18n() / loadI18nOverride()
// 测试环境已在同一上下文预加载 lib.js，importScripts 失败可忽略
try { importScripts('lib.js'); } catch (e) {}
try { importScripts('i18n.js'); } catch (e) {}
// i18n.js 未加载时（如测试环境）的兜底：等价原生 chrome.i18n 行为
if (typeof globalThis.i18n !== 'function') {
  globalThis.i18n = (k, subs) => chrome.i18n.getMessage(k, subs) || k;
}
if (typeof globalThis.loadI18nOverride !== 'function') {
  globalThis.loadI18nOverride = async () => {};
}

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:16801',
  apiToken: '',
  servers: [],              // [{name, url, token, pattern}]；为空时用 serverUrl/apiToken 构造默认项
  enabled: true,
  domainMode: 'off',        // off | blacklist | whitelist
  domainList: '',
  extMode: 'off',           // off | whitelist | blacklist
  extList: '',
  minSizeMB: 0,
  captureUnknownSize: true,
  captureMagnet: true,
  notifyComplete: true,
  sniffEnabled: true,       // 网页媒体嗅探总开关
  allowExternalRequest: false, // 第三方扩展下载请求（默认关闭，安全）
  deepSearch: false,        // 深度搜索：页面加载完成后自动执行（popup 也可手动触发）
  sniffRegexRules: [],      // [{url: 通配符或 /正则/, state: true}]；为空 = 全部进嗅探列表
  fileNameTemplate: '',     // 文件名模板，空 = 服务器默认命名；变量 ${title} ${fileName} ${ext} ${host} ${date}
  autoDownloadSniffed: false, // 自动下载嗅探到的媒体
  autoDownloadMinSizeMB: 10,  // 自动下载最小体积（MB）
  askBeforeDownload: false, // 下载前弹出参数确认窗口（文件名/分片/目标服务器可改）
  panelOpenStyle: 'popup'   // 管理面板打开方式：popup | newtab | window | sidepanel
};

const STREAM_RE = /\.(m3u8|mpd)(\?|#|$)/i;
// i18n 全局函数由 i18n.js 提供（见文件顶部兜底）

async function cfg() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

// ============================================================
// 请求头捕获（Gopeed 方案）：onBeforeSendHeaders 按 URL 精确匹配
// ============================================================
const requestHeaderMap = new Map(); // url -> { headers, ts }
const HEADER_CAP_MAX = 200;
const HEADER_TTL = 30000;

function storeRequestHeaders(details) {
  if (!details.requestHeaders?.length) return;
  const headers = {};
  for (const h of details.requestHeaders) {
    if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
  }
  if (Object.keys(headers).length) {
    requestHeaderMap.set(details.url, { headers, ts: Date.now() });
    if (requestHeaderMap.size > HEADER_CAP_MAX) {
      // 简单淘汰最旧的一半
      const entries = [...requestHeaderMap.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < entries.length / 2; i++) requestHeaderMap.delete(entries[i][0]);
    }
  }
}

function consumeRequestHeaders(url) {
  const hit = requestHeaderMap.get(url);
  if (hit) requestHeaderMap.delete(url);
  return hit?.headers || null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of requestHeaderMap) if (now - v.ts > HEADER_TTL) requestHeaderMap.delete(k);
  for (const [k, v] of sniffHeaderMap) if (now - v.ts > HEADER_TTL) sniffHeaderMap.delete(k);
  void sweepPendingConfirms().catch(() => {});
}, 30000);

// 导航/子框架/下载触发的请求都缓存（extraHeaders 才能看到 Cookie/Referer）
chrome.webRequest.onBeforeSendHeaders.addListener(
  storeRequestHeaders,
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'other'] },
  ['requestHeaders', 'extraHeaders']
);

// ============================================================
// Cookie 兜底（Aria2-Explorer 方案）：chrome.cookies.getAll + 分区 Cookie 合并
// ============================================================
async function getCookiesFor(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    let partitioned = [];
    try { partitioned = await chrome.cookies.getAll({ url, partitionKey: {} }); } catch {}
    const map = new Map([...cookies, ...partitioned].map(c => [c.name, c.value]));
    return [...map].map(([n, v]) => `${n}=${v}`);
  } catch { return []; }
}

/** 组装发送给下载器的请求头：webRequest 精确快照优先，cookies API 兜底 */
async function buildHeaders(url, referrer) {
  const out = [];
  const captured = consumeRequestHeaders(url);
  if (captured) {
    if (captured.cookie) out.push(`Cookie: ${captured.cookie}`);
    if (captured['user-agent']) out.push(`User-Agent: ${captured['user-agent']}`);
    if (captured.referer) out.push(`Referer: ${captured.referer}`);
    if (captured.origin) out.push(`Origin: ${captured.origin}`);
    if (captured.authorization) out.push(`Authorization: ${captured.authorization}`);
  }
  if (!out.some(h => h.startsWith('Cookie:'))) {
    const cookies = await getCookiesFor(url);
    if (cookies.length) out.push(`Cookie: ${cookies.join('; ')}`);
  }
  if (!out.some(h => h.startsWith('User-Agent:'))) out.push(`User-Agent: ${navigator.userAgent}`);
  if (!out.some(h => h.startsWith('Referer:')) && referrer && referrer !== 'about:blank') {
    out.push(`Referer: ${referrer}`);
  }
  // 强制原始字节响应（Gopeed 技巧）：gzip/br 压缩会让分段下载的字节偏移错乱导致文件损坏
  out.push('Accept-Encoding: identity');
  return out;
}

// ============================================================
// 过滤系统（Aria2-Explorer 优先级：域名 → 后缀 → 大小；通配符匹配）
// ============================================================
function matchWildcard(str, rule) {
  try {
    return new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(str);
  } catch { return false; }
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

// 域名规则匹配：'*.a.com' 同时匹配 'a.com' 顶级域与所有子域
function matchDomain(host, rule) {
  if (matchWildcard(host, rule)) return true;
  if (rule.startsWith('*.')) {
    const bare = rule.slice(2);
    return host === bare || host.endsWith('.' + bare);
  }
  return false;
}

function shouldCapture(c, item, pageHost) {
  const url = item.finalUrl || item.url || '';
  // 防自捕获（回退浏览器下载会再次触发本监听）
  if (item.byExtensionId === chrome.runtime.id) return false;
  if (!/^https?:/i.test(url)) return false;
  // 流媒体直链始终接管
  if (STREAM_RE.test(url)) return true;

  const urlHost = hostOf(url);
  const domains = c.domainList.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (c.domainMode !== 'off' && domains.length) {
    const hit = domains.some(r => matchDomain(urlHost, r) || (pageHost && matchDomain(pageHost, r)));
    if (c.domainMode === 'blacklist' && hit) return false;
    if (c.domainMode === 'whitelist' && !hit) return false;
  }

  const filename = (item.filename || url.split('/').pop() || '').toLowerCase();
  const exts = c.extList.split(/[\s,]+/).map(s => s.trim().toLowerCase().replace(/^\.?/, '.')).filter(s => s.length > 1);
  if (c.extMode !== 'off' && exts.length) {
    const hit = exts.some(e => filename.endsWith(e));
    if (c.extMode === 'blacklist' && hit) return false;
    if (c.extMode === 'whitelist' && !hit) return false;
  }

  const size = item.totalBytes ?? item.fileSize ?? -1;
  if (c.minSizeMB > 0) {
    if (size > 0 && size < c.minSizeMB * 1048576) return false;
    if (size <= 0 && !c.captureUnknownSize) return false;
  }
  return true;
}

// ============================================================
// 多服务器 URL 路由（Aria2-Explorer getRpcServer/rpcList 模式）
// servers: [{name, url, token, pattern}]，pattern 逗号分隔通配符，
// 按顺序匹配 下载URL+文件名，首个命中者接收任务；
// pattern 为 '*'（或留空）的项是默认服务器；列表第一项兜底。
// ============================================================
function resolveServers(c) {
  if (Array.isArray(c.servers) && c.servers.length) {
    const valid = c.servers.filter(s => s && s.url);
    if (valid.length) return valid;
  }
  // 迁移兼容：用旧版单服务器字段构造默认项
  return [{ name: i18n('srvDefault'), url: c.serverUrl, token: c.apiToken, pattern: '*' }];
}

function routeServer(servers, target) {
  if (!servers?.length) return null;
  let dft = null;
  for (const srv of servers) {
    const pattern = (srv.pattern || '').trim();
    if (!pattern || pattern === '*') { if (!dft) dft = srv; continue; }
    for (const p of pattern.split(',')) {
      const rule = p.trim();
      if (rule && matchWildcard(target, rule)) return srv;
    }
  }
  return dft || servers[0];
}

// 默认服务器：pattern '*' 的项，否则列表第一项（badge/统计/WS 轮询用）
function defaultServer(servers) {
  return servers.find(s => !(s.pattern || '').trim() || s.pattern.trim() === '*') || servers[0];
}

// ============================================================
// 任务发送
// ============================================================
async function postTask(server, url, { referer, headers, extraOptions } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (server.token) h['Authorization'] = 'Bearer ' + server.token;
  const options = { ...(extraOptions || {}) };
  if (referer && referer !== 'about:blank') options.referer = referer;
  if (headers?.length) options.headers = headers;
  const res = await fetch(server.url.replace(/\/+$/, '') + '/api/v1/tasks', {
    method: 'POST', headers: h, body: JSON.stringify({ url, options }), signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon128.png', title, message
  });
}

async function resolvePageTitle(referer) {
  if (!referer || !/^https?:/i.test(referer)) return '';
  try {
    if (!chrome.tabs?.query) return '';
    const tabs = await chrome.tabs.query({ url: referer });
    return tabs?.[0]?.title || '';
  } catch { return ''; }
}

async function sendToKimi(url, { referer, filename, headersOverride, extraOptions, pageTitle } = {}) {
  const c = await cfg();
  const servers = resolveServers(c);
  // 路由匹配目标：下载 URL + 文件名（Aria2-Explorer 同款拼接）
  const srv = routeServer(servers, url + (filename || '')) || defaultServer(servers);
  const headers = headersOverride || await buildHeaders(url, referer);
  const opts = { ...(extraOptions || {}) };
  // 文件名模板（cat-catch templates.js 变量体系）：渲染结果作为 options.out 传给后端
  if (!opts.out && c.fileNameTemplate) {
    const title = pageTitle || await resolvePageTitle(referer);
    const out = renderFileNameTemplate(c.fileNameTemplate, { url, title });
    if (out) opts.out = out;
  }
  await postTask(srv, url, { referer, headers, extraOptions: opts });
  notify(i18n('sentToKimi'), filename || opts.out || url);
}

// ============================================================
// 下载前参数确认（Aria2-Explorer askBeforeDownload 模式）：
// 下载接管流程 pause 后不直接发送，挂起任务进 pendingConfirms，
// 弹 popup.html?mode=confirm&token=xxx 由用户确认/取消。
// Map 存内存，chrome.storage.session 兜底防 Service Worker 重启丢失。
// ============================================================
const pendingConfirms = new Map(); // token -> {url, referer, filename, headers, itemId, ts}
const PENDING_TTL = 10 * 60 * 1000; // 待确认任务 10 分钟过期
const PENDING_KEY_PREFIX = 'kimi-pending-';
const pendingOperations = new Map();
function pendingOperation(token, action) {
  const previous = pendingOperations.get(token) || pendingRestore;
  const result = previous.catch(() => {}).then(action);
  pendingOperations.set(token, result);
  void result.finally(() => { if (pendingOperations.get(token) === result) pendingOperations.delete(token); }).catch(() => {});
  return result;
}
async function releasePendingEntry(token, entry) {
  if (entry?.itemId != null) {
    try { await chrome.downloads.resume(entry.itemId); }
    catch {
      // Keep recoverable state if Chrome temporarily refuses to resume.
      // Completed/removed downloads do not need further recovery attempts.
      let finished = false;
      try {
        if (chrome.downloads.search) {
          const [item] = await chrome.downloads.search({ id: entry.itemId });
          finished = !item || item.state === 'complete' || (item.state === 'interrupted' && !item.canResume);
        }
      } catch {}
      if (!finished) {
        entry.releaseRequested = true;
        try { await chrome.storage.session?.set({ [PENDING_KEY_PREFIX + token]: entry }); } catch {}
        return;
      }
    }
  }
  await removePendingConfirm(token);
}
async function restorePendingConfirms() {
  const all = await chrome.storage.session?.get(null);
  for (const [key, entry] of Object.entries(all || {})) {
    if (!key.startsWith(PENDING_KEY_PREFIX) || !entry || typeof entry !== 'object') continue;
    const token = key.slice(PENDING_KEY_PREFIX.length);
    pendingConfirms.set(token, entry);
    let missing = false;
    if (chrome.windows.get && entry.windowId != null) {
      try { await chrome.windows.get(entry.windowId); } catch { missing = true; }
    }
    if (missing || entry.releaseRequested || !Number.isFinite(entry.ts) || Date.now() - entry.ts > PENDING_TTL) await cancelPendingDownloadNow(token);
  }
}
async function sweepPendingConfirms() {
  await pendingRestore;
  for (const [token, entry] of pendingConfirms) {
    if (entry.releaseRequested || !Number.isFinite(entry.ts) || Date.now() - entry.ts > PENDING_TTL) await cancelPendingDownload(token);
  }
}
chrome.windows.onRemoved?.addListener((windowId) => {
  for (const [token, entry] of pendingConfirms) {
    if (entry.windowId === windowId) void cancelPendingDownload(token).catch(() => {});
  }
});
const pendingRestore = restorePendingConfirms().catch(() => {});
chrome.alarms.create('rdown-pending-cleanup', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'rdown-pending-cleanup') void sweepPendingConfirms().catch(() => {}); });

function newToken() {
  try {
    const buf = new Uint8Array(8);
    globalThis.crypto?.getRandomValues(buf);
    if (buf.some(b => b)) return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {}
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function addPendingConfirm(data) {
  await pendingRestore;
  const token = newToken();
  const entry = { ...data, ts: Date.now() };
  pendingConfirms.set(token, entry);
  try { await chrome.storage.session?.set({ [PENDING_KEY_PREFIX + token]: entry }); } catch {}
  return token;
}

async function getPendingConfirm(token) {
  if (!token) return null;
  let entry = pendingConfirms.get(token);
  if (!entry) {
    // SW 重启后内存丢失，从 session 存储恢复
    try {
      const j = await chrome.storage.session?.get(PENDING_KEY_PREFIX + token);
      entry = j?.[PENDING_KEY_PREFIX + token];
      if (entry) pendingConfirms.set(token, entry);
    } catch {}
  }
  if (entry && (entry.releaseRequested || !Number.isFinite(entry.ts) || Date.now() - entry.ts > PENDING_TTL)) {
    await releasePendingEntry(token, entry);
    return null;
  }
  return entry || null;
}

async function removePendingConfirm(token) {
  pendingConfirms.delete(token);
  try { await chrome.storage.session?.remove(PENDING_KEY_PREFIX + token); } catch {}
}

// 确认弹窗服务器下拉：全部服务器 + 按 v3 路由逻辑预选项（routeServer 命中者）
function resolveConfirmServers(c, url, filename) {
  const servers = resolveServers(c);
  const matched = routeServer(servers, url + (filename || '')) || defaultServer(servers);
  return { servers, matchedIndex: Math.max(0, servers.indexOf(matched)) };
}

// 确认弹窗提交流程：POST 任务 → cancel+erase 浏览器下载；取消 → resume 恢复
function confirmPendingDownload(token, options = {}) {
  return pendingOperation(token, () => confirmPendingDownloadNow(token, options));
}
async function confirmPendingDownloadNow(token, { filename, split, serverIndex } = {}) {
  const entry = await getPendingConfirm(token);
  if (!entry) return { error: 'expired' };
  const c = await cfg();
  const servers = resolveServers(c);
  let srv = null;
  if (Number.isInteger(serverIndex) && servers[serverIndex]) srv = servers[serverIndex];
  if (!srv) srv = routeServer(servers, entry.url + (entry.filename || '')) || defaultServer(servers);
  const extraOptions = {};
  const out = (filename || '').trim();
  if (out) extraOptions.out = out;
  const sp = Math.max(0, Number(split) || 0);
  if (sp > 0) extraOptions.split = sp;
  if (!extraOptions.out && c.fileNameTemplate) {
    const title = await resolvePageTitle(entry.referer);
    const rendered = renderFileNameTemplate(c.fileNameTemplate, { url: entry.url, title });
    if (rendered) extraOptions.out = rendered;
  }
  await postTask(srv, entry.url, { referer: entry.referer, headers: entry.headers, extraOptions });
  await removePendingConfirm(token);
  if (entry.itemId != null) {
    try { await chrome.downloads.cancel(entry.itemId); } catch {}
    try { await chrome.downloads.erase({ id: entry.itemId }); } catch {}
  }
  notify(i18n('sentToKimi'), extraOptions.out || entry.filename || entry.url);
  return { ok: true };
}

function cancelPendingDownload(token) {
  return pendingOperation(token, () => cancelPendingDownloadNow(token));
}
async function cancelPendingDownloadNow(token) {
  // Do not use getPendingConfirm here: its expiry path also releases entries.
  let entry = pendingConfirms.get(token);
  if (!entry) {
    try {
      const saved = await chrome.storage.session?.get(PENDING_KEY_PREFIX + token);
      entry = saved?.[PENDING_KEY_PREFIX + token];
      if (entry) pendingConfirms.set(token, entry);
    } catch {}
  }
  if (entry) await releasePendingEntry(token, entry);
  return { ok: true };
}

// ============================================================
// 网页流媒体嗅探（猫抓 cat-catch 方案）：
// onSendHeaders 按 requestId 缓存请求头（extraHeaders）→
// onResponseStarted 读取 responseHeaders 匹配媒体资源并配对请求头 →
// onErrorOccurred 清理孤立的 requestId
// ============================================================
const MEDIA_EXTS = new Set([
  'm3u8', 'mpd', 'mp4', 'm4s', 'm4v', 'm4a', 'ts', 'aac', 'mp3',
  'flv', 'flac', 'ogg', 'ogv', 'webm', 'mkv', 'avi', 'mov', 'wav'
]);
const MEDIA_CT_RE = /mpegurl|dash\+xml|^video\/|^audio\//;
const sniffHeaderMap = new Map();   // requestId -> { headers, ts }
const sniffedMedia = new Map();     // tabId -> Map<url, {url, type, size, contentType, filename, headers, ts, source}>
const SNIFF_HDR_MAX = 5000;
const SNIFF_MAX_PER_TAB = 200;
let sniffEnabledCache = true;
let sniffRulesCache = [];           // sniffRegexRules 缓存（[{url, state}]）
let deepSearchCache = false;        // deepSearch 自动执行开关缓存
const autoSentSet = new Set();      // 自动下载防重复：同一 URL 只自动发一次
cfg().then(c => {
  sniffEnabledCache = c.sniffEnabled !== false;
  sniffRulesCache = Array.isArray(c.sniffRegexRules) ? c.sniffRegexRules : [];
  deepSearchCache = !!c.deepSearch;
}).catch(() => {});

// 纯匹配函数（便于测试）：URL 后缀 或 响应 Content-Type 或 media 资源类型
function sniffMatch(url, contentType, resourceType) {
  if (!/^https?:/i.test(url || '')) return null;
  let ext = '';
  try {
    const pathname = new URL(url).pathname;
    const mm = pathname.match(/\.([a-z0-9]{1,5})$/i);
    if (mm) ext = mm[1].toLowerCase();
  } catch { return null; }
  const ct = (contentType || '').toLowerCase();
  if (MEDIA_EXTS.has(ext)) return { ext };
  if (MEDIA_CT_RE.test(ct)) return { ext: ext || ct.split('/')[1] || '' };
  if (resourceType === 'media') return { ext: ext || 'media' };
  return null;
}

function mediaTypeLabel(ext, contentType) {
  if (ext === 'm3u8' || /mpegurl/i.test(contentType || '')) return 'HLS';
  if (ext === 'mpd' || /dash\+xml/i.test(contentType || '')) return 'DASH';
  if (ext) return ext.toUpperCase();
  return 'MEDIA';
}

// 解析响应头：content-length / content-type / content-range（猫抓 getResponseHeadersValue 同款）
function sniffParseResponseHeaders(responseHeaders) {
  const out = {};
  for (const h of responseHeaders || []) {
    const n = (h.name || '').toLowerCase();
    if (n === 'content-length') { out.size = parseInt(h.value) || out.size; }
    else if (n === 'content-type') { out.type = (h.value || '').split(';')[0].trim().toLowerCase(); }
    else if (n === 'content-range') {
      const s = (h.value || '').split('/')[1];
      if (s && s !== '*') out.size = parseInt(s) || out.size;
    }
  }
  return out;
}

// 只保留下载需要的请求头（猫抓 getRequestHeaders 思路）
const SNIFF_KEEP_HEADERS = new Set(['cookie', 'user-agent', 'referer', 'origin', 'authorization']);
function filterSniffHeaders(raw) {
  const out = {};
  for (const h of raw || []) {
    const n = (h.name || '').toLowerCase();
    if (SNIFF_KEEP_HEADERS.has(n) && h.value) out[n] = h.value;
  }
  return out;
}

function sniffHeadersToLines(obj) {
  const lines = [];
  if (obj?.cookie) lines.push('Cookie: ' + obj.cookie);
  if (obj?.['user-agent']) lines.push('User-Agent: ' + obj['user-agent']);
  if (obj?.referer) lines.push('Referer: ' + obj.referer);
  if (obj?.origin) lines.push('Origin: ' + obj.origin);
  if (obj?.authorization) lines.push('Authorization: ' + obj.authorization);
  lines.push('Accept-Encoding: identity');
  return lines;
}

function sniffStoreRequestHeaders(details) {
  if (!sniffEnabledCache || !details.requestHeaders?.length) return;
  sniffHeaderMap.set(details.requestId, { headers: details.requestHeaders, tabId: details.tabId, ts: Date.now() });
  if (sniffHeaderMap.size > SNIFF_HDR_MAX) sniffHeaderMap.clear(); // 猫抓同款：超限整体清空
}

function sniffOnResponseStarted(details) {
  try {
    const hit = sniffHeaderMap.get(details.requestId);
    if (hit) sniffHeaderMap.delete(details.requestId);
    if (!sniffEnabledCache) return;
    sniffFindMedia(details, hit?.headers);
  } catch {}
}

function sniffOnErrorOccurred(details) {
  sniffHeaderMap.delete(details.requestId);
}

function sniffFindMedia(details, reqHeaders) {
  // 排除：OPTIONS 预检、非标签页请求、非 http(s)、扩展（含自身）发起的请求
  if (details.method === 'OPTIONS') return;
  if (details.tabId == null || details.tabId < 0) return;
  const url = details.url || '';
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;

  const resp = sniffParseResponseHeaders(details.responseHeaders);
  const m = sniffMatch(url, resp.type, details.type);
  if (!m) return;
  // 嗅探正则过滤（cat-catch 方案）：规则非空时仅命中 state=true 规则的 URL 进列表
  if (!matchSniffRegexRules(sniffRulesCache, url)) return;

  let tab = sniffedMedia.get(details.tabId);
  if (!tab) { tab = new Map(); sniffedMedia.set(details.tabId, tab); }
  if (tab.has(url)) return; // 按 URL 查重
  if (tab.size >= SNIFF_MAX_PER_TAB) tab.delete(tab.keys().next().value); // 淘汰最旧

  let filename = '';
  try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); }
  catch { filename = new URL(url).pathname.split('/').pop() || ''; }
  const entry = {
    url,
    type: mediaTypeLabel(m.ext, resp.type),
    size: resp.size || 0,
    contentType: resp.type || '',
    filename: filename || url,
    headers: filterSniffHeaders(reqHeaders),
    ts: Date.now(),
    source: 'network'
  };
  tab.set(url, entry);
  updateSniffBadge(details.tabId);
  maybeAutoDownload(entry);
}

// ============================================================
// 深度搜索（cat-catch 方案）：内容脚本注入页面主上下文扫描到的媒体 URL
// 经消息回传后加入该 tab 的嗅探列表（source: 'deepSearch'）
// ============================================================
function addDeepSearchMedia(tabId, urls, pageHref) {
  if (!sniffEnabledCache || !Array.isArray(urls)) return 0;
  let added = 0;
  for (const url of urls) {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) continue;
    const m = sniffMatch(url, '', 'other');
    if (!m) continue;
    if (!matchSniffRegexRules(sniffRulesCache, url)) continue;
    let tab = sniffedMedia.get(tabId);
    if (!tab) { tab = new Map(); sniffedMedia.set(tabId, tab); }
    if (tab.has(url)) continue;
    if (tab.size >= SNIFF_MAX_PER_TAB) tab.delete(tab.keys().next().value);
    let filename = '';
    try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); }
    catch { filename = new URL(url).pathname.split('/').pop() || ''; }
    const entry = {
      url,
      type: mediaTypeLabel(m.ext, ''),
      size: 0,
      contentType: '',
      filename: filename || url,
      headers: { referer: pageHref || '' },
      ts: Date.now(),
      source: 'deepSearch'
    };
    tab.set(url, entry);
    added++;
    maybeAutoDownload(entry);
  }
  if (added) updateSniffBadge(tabId);
  return added;
}

// ============================================================
// 自动下载嗅探媒体：体积 ≥ 阈值才发送；m3u8 直播流（体积未知）跳过；
// 同一 URL 只自动发一次（autoSentSet 防重复）
// ============================================================
async function maybeAutoDownload(media) {
  try {
    const c = await cfg();
    if (!shouldAutoDownload(media, c, autoSentSet)) return;
    autoSentSet.add(media.url);
    const headers = sniffHeadersToLines(media.headers);
    await sendToKimi(media.url, {
      referer: media.headers?.referer,
      filename: media.filename,
      headersOverride: headers
    });
    notify(i18n('autoDownloaded'), media.filename || media.url);
  } catch (e) {
    autoSentSet.delete(media.url);
    notify(i18n('sendFailed'), String(e.message || e));
  }
}

// 猫抓同款：<all_urls> 全量监听 + extraHeaders 拿 Cookie/Referer
chrome.webRequest.onSendHeaders?.addListener(
  sniffStoreRequestHeaders,
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);
chrome.webRequest.onResponseStarted?.addListener(
  sniffOnResponseStarted,
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);
chrome.webRequest.onErrorOccurred?.addListener(
  sniffOnErrorOccurred,
  { urls: ['<all_urls>'] }
);
// tab 关闭时清理该 tab 的嗅探数据
chrome.tabs.onRemoved?.addListener((tabId) => {
  sniffedMedia.delete(tabId);
  for (const [id, entry] of sniffHeaderMap) if (entry.tabId === tabId) sniffHeaderMap.delete(id);
});
// 深度搜索自动执行：选项页开启 deepSearch 后，页面加载完成即触发内容脚本扫描
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    sniffedMedia.delete(tabId);
    try { chrome.action.setBadgeText({ text: '', tabId }); } catch {}
    for (const [id, entry] of sniffHeaderMap) if (entry.tabId === tabId) sniffHeaderMap.delete(id);
  }
  if (changeInfo.status === 'complete' && deepSearchCache && sniffEnabledCache) {
    chrome.tabs.sendMessage(tabId, { type: 'kimi-deep-search' }).catch(() => {});
  }
});

// ============================================================
// 下载接管（Gopeed 流程：不返回 true → 不欠 suggest；
// 接管时 pause → 发送 → 成功 cancel+erase / 失败 resume 回退）
// ============================================================
let altBypassUntil = 0; // Alt 旁路时间窗

chrome.downloads.onDeterminingFilename.addListener((item) => {
  (async () => {
    const c = await cfg();
    if (!c.enabled) return;
    if (Date.now() < altBypassUntil) { altBypassUntil = 0; return; } // Alt 点击旁路（消费一次）
    let pageHost = '';
    if (item.referrer) pageHost = hostOf(item.referrer);
    if (!shouldCapture(c, item, pageHost)) return;

    const url = item.finalUrl || item.url;
    try { await chrome.downloads.pause(item.id); } catch {}
    // 下载前确认（Aria2-Explorer askBeforeDownload 流程）：pause 后挂起，
    // 弹确认窗口由用户决定发送/取消，此处不直接发送
    if (c.askBeforeDownload) {
      let token = null;
      try {
        const headers = await buildHeaders(url, item.referrer);
        token = await addPendingConfirm({
          url, referer: item.referrer || '', filename: item.filename || '', headers, itemId: item.id
        });
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL('popup.html') + '?mode=confirm&token=' + token,
          type: 'popup', width: 360, height: 520, focused: true
        });
        const entry = pendingConfirms.get(token);
        if (entry && win?.id != null) {
          entry.windowId = win.id;
          await chrome.storage.session?.set({ [PENDING_KEY_PREFIX + token]: entry });
          if (chrome.windows.get) {
            try { await chrome.windows.get(win.id); } catch { await cancelPendingDownload(token); }
          }
        }
      } catch (e) {
        if (token) await removePendingConfirm(token);
        try { await chrome.downloads.resume(item.id); } catch {}
        notify(i18n('sendFailed'), String(e.message || e));
      }
      return;
    }
    try {
      await sendToKimi(url, { referer: item.referrer, filename: item.filename });
      await chrome.downloads.cancel(item.id).catch(() => {});
      chrome.downloads.erase({ id: item.id });
    } catch (e) {
      // 回退：恢复浏览器下载
      try { await chrome.downloads.resume(item.id); } catch {}
      notify(i18n('sendFailed'), String(e.message || e));
    }
  })();
  // 注意：不返回 true —— 不接管时 Chrome 立即按默认文件名继续，不会挂起
});

// ============================================================
// 右键菜单
// ============================================================
const MENUS = [
  { id: 'kimi-link', key: 'menuLink', contexts: ['link'] },
  { id: 'kimi-media', key: 'menuMedia', contexts: ['image', 'video', 'audio'] },
  { id: 'kimi-page', key: 'menuPage', contexts: ['page'] }
];

// 每次重建菜单前先刷新语言覆盖层（onInstalled/onStartup/语言切换时调用），标题按当前语言重取
async function createMenus() {
  try { await loadI18nOverride(); } catch (e) {}
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) chrome.contextMenus.create({ id: m.id, title: i18n(m.key), contexts: m.contexts });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// 首次安装引导（onboarding）：仅 reason==='install' 时打开引导页并复位完成标记；
// update / chrome_update / shared_module_update 严禁弹窗
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ onboardingCompleted: false });
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html'), active: true });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'kimi-link' && info.linkUrl) {
    sendToKimi(info.linkUrl, { referer: info.pageUrl }).catch(e => notify(i18n('sendFailed'), String(e)));
  } else if (info.menuItemId === 'kimi-media' && info.srcUrl) {
    sendToKimi(info.srcUrl, { referer: info.pageUrl }).catch(e => notify(i18n('sendFailed'), String(e)));
  } else if (info.menuItemId === 'kimi-page' && tab?.id != null) {
    collectPageLinks(tab.id, info.pageUrl);
  }
});

async function collectPageLinks(tabId, pageUrl) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'kimi-collect-links' });
    const urls = [...new Set(result || [])].filter(u => /^(https?|magnet):/i.test(u));
    if (!urls.length) { notify(i18n('menuPage'), i18n('noLinksFound')); return; }
    const c = await cfg();
    const servers = resolveServers(c);
    let ok = 0, fail = 0;
    for (const u of urls) {
      try {
        const headers = /^magnet:/i.test(u) ? [] : await buildHeaders(u, pageUrl);
        const srv = routeServer(servers, u) || defaultServer(servers);
        await postTask(srv, u, { referer: pageUrl, headers });
        ok++;
      } catch { fail++; }
    }
    notify(i18n('menuPage'), i18n('batchResult', [String(ok), fail ? i18n('batchResultFail', String(fail)) : '']));
  } catch (e) { notify(i18n('menuPage'), String(e.message || e)); }
}

// ============================================================
// 快捷键
// ============================================================
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'toggle-capture') {
    const c = await cfg();
    await chrome.storage.sync.set({ enabled: !c.enabled });
    notify(i18n('cmdToggle'), !c.enabled ? i18n('captureOn') : i18n('captureOff'));
    refreshBadge();
  } else if (cmd === 'open-panel') {
    const c = await cfg();
    const srv = defaultServer(resolveServers(c));
    chrome.tabs.create({ url: srv.url.replace(/\/+$/, '') });
  }
});

// ============================================================
// 管理面板多形态（Aria2-Explorer webUIOpenStyle 模式）：
// popup    = 点击图标开 popup.html（manifest default_popup，onClicked 不触发）
// newtab   = 点击图标新标签页打开服务器地址
// window   = 点击图标 1100x720 独立窗口打开服务器地址
// sidepanel= 点击图标打开侧边栏（side_panel 默认路径 popup.html）
// 非 popup 形态需在运行时 chrome.action.setPopup({popup:''}) 清空，
// 图标点击才会派发 action.onClicked（Aria2-Explorer 379-383/964-970 同款做法）
// ============================================================
const PANEL_STYLES = new Set(['popup', 'newtab', 'window', 'sidepanel']);

function normalizePanelStyle(style) {
  return PANEL_STYLES.has(style) ? style : 'popup';
}

// 按配置切换图标点击形态（SW 启动时与选项变更时调用）
async function applyPanelStyle(style) {
  const s = normalizePanelStyle(style);
  try { await chrome.action.setPopup({ popup: s === 'popup' ? 'popup.html' : '' }); } catch {}
  if (s === 'sidepanel') {
    try { await chrome.sidePanel?.setOptions({ path: 'popup.html' }); } catch {}
  }
}

// 非 popup 形态的图标点击行为
async function openPanel(style, tab) {
  const s = normalizePanelStyle(style);
  if (s === 'popup') return; // popup 形态由 default_popup 处理，不会走到这里
  const c = await cfg();
  const srv = defaultServer(resolveServers(c));
  const url = srv.url.replace(/\/+$/, '');
  if (s === 'newtab') {
    try { await chrome.tabs.create({ url }); } catch {}
  } else if (s === 'window') {
    try { await chrome.windows.create({ type: 'popup', width: 1100, height: 720, url, focused: true }); } catch {}
  } else if (s === 'sidepanel') {
    try { await chrome.sidePanel?.setOptions({ path: 'popup.html' }); } catch {}
    try {
      if (tab?.windowId != null) await chrome.sidePanel?.open({ windowId: tab.windowId });
    } catch {}
  }
}

chrome.action.onClicked?.addListener((tab) => {
  cfg().then(c => openPanel(c.panelOpenStyle, tab)).catch(() => {});
});

// SW 启动时按配置恢复图标形态（运行时 setPopup 不持久，需每次启动重放）
cfg().then(c => applyPanelStyle(c.panelOpenStyle)).catch(() => {});

// popup 开关同步 + 嗅探媒体查询/下载
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'capture-toggled') { refreshBadge(); }
  if (msg?.type === 'CLICK_EVENT' && msg.altKey) { altBypassUntil = Date.now() + 3000; }
  if (msg?.type === 'MAGNET_DOWNLOAD' && msg.url) {
    cfg().then(c => {
      if (c.enabled && c.captureMagnet) {
        sendToKimi(msg.url, { referer: msg.referer }).catch(e => notify(i18n('sendFailed'), String(e)));
      }
    });
  }
  // popup 查询当前 tab 嗅探到的媒体列表
  if (msg?.type === 'getSniffedMedia') {
    const tab = sniffedMedia.get(msg.tabId);
    sendResponse(tab ? [...tab.values()] : []);
    return true;
  }
  // 内容脚本回传的深度搜索结果（页面主上下文扫描到的媒体 URL）
  if (msg?.type === 'kimi-deep-search-media' && Array.isArray(msg.urls)) {
    const tabId = sender?.tab?.id;
    if (tabId != null && tabId >= 0) {
      addDeepSearchMedia(tabId, msg.urls, msg.href || sender.tab?.url || '');
    }
    return;
  }
  // popup"深度搜索"按钮：向当前 tab 的内容脚本发消息执行扫描
  if (msg?.type === 'triggerDeepSearch' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'kimi-deep-search' })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  // popup 点击下载某个嗅探到的媒体（带嗅探时捕获的请求头）
  if (msg?.type === 'downloadSniffed' && msg.url) {
    (async () => {
      try {
        const media = sniffedMedia.get(msg.tabId)?.get(msg.url);
        // m3u8/mpd 由后端识别为流媒体任务，其他按普通任务；均携带捕获的请求头
        const headers = media ? sniffHeadersToLines(media.headers) : await buildHeaders(msg.url, msg.referer);
        await sendToKimi(msg.url, {
          referer: media?.headers?.referer || msg.referer,
          filename: media?.filename,
          headersOverride: headers
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ error: String(e.message || e) }); }
    })();
    return true;
  }
  // 确认弹窗：查询待确认任务（含按路由预选的服务器列表）
  if (msg?.type === 'getPendingConfirm' && msg.token) {
    (async () => {
      try {
        await pendingRestore;
        const entry = await pendingOperation(msg.token, () => getPendingConfirm(msg.token));
        if (!entry) { sendResponse({ error: 'expired' }); return; }
        const c = await cfg();
        const { servers, matchedIndex } = resolveConfirmServers(c, entry.url, entry.filename);
        sendResponse({
          url: entry.url,
          referer: entry.referer || '',
          filename: entry.filename || '',
          servers: servers.map(s => ({ name: s.name || '', url: s.url })),
          matchedIndex
        });
      } catch (e) { sendResponse({ error: String(e.message || e) }); }
    })();
    return true;
  }
  // 确认弹窗 [开始下载]：发送任务并取消浏览器下载
  if (msg?.type === 'confirmDownload' && msg.token) {
    (async () => {
      try {
        sendResponse(await confirmPendingDownload(msg.token, {
          filename: msg.filename, split: msg.split, serverIndex: msg.serverIndex
        }));
      } catch (e) { sendResponse({ error: String(e.message || e) }); }
    })();
    return true;
  }
  // 确认弹窗 [取消]：恢复浏览器下载
  if (msg?.type === 'cancelPendingDownload' && msg.token) {
    (async () => {
      try { sendResponse(await cancelPendingDownload(msg.token)); }
      catch (e) { sendResponse({ error: String(e.message || e) }); }
    })();
    return true;
  }
});

// ============================================================
// 第三方扩展中间件 API（Aria2-Explorer onMessageExternal 模式）
// 接收 {type:'download', url, filename, referrer, options}
// 走与内部下载相同的过滤/发送流程；需选项页开启 allowExternalRequest
// ============================================================
const EXTERNAL_OPTION_KEYS = ['dir', 'out', 'userAgent', 'cookie', 'split', 'maxConnectionPerServer', 'selectFile', 'seedTime'];
function sanitizeExternalOptions(src) {
  const out = {};
  for (const k of EXTERNAL_OPTION_KEYS) {
    if (src && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

chrome.runtime.onMessageExternal?.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const c = await cfg();
      if (!c.allowExternalRequest) { sendResponse({ error: 'external requests disabled' }); return; }
      if (msg?.type !== 'download' || !msg.url || typeof msg.url !== 'string') {
        sendResponse({ error: 'invalid download request' }); return;
      }
      const url = msg.url;
      if (!/^(https?|magnet):/i.test(url)) { sendResponse({ error: 'unsupported url scheme' }); return; }
      const referer = typeof msg.referrer === 'string' ? msg.referrer : undefined;
      const filename = typeof msg.filename === 'string' ? msg.filename : undefined;
      // 与内部下载相同的过滤流程
      if (/^magnet:/i.test(url)) {
        if (!c.captureMagnet) { sendResponse({ error: 'magnet capture disabled' }); return; }
      } else {
        const item = { url, finalUrl: url, filename: filename || '', totalBytes: -1 };
        if (!shouldCapture(c, item, referer ? hostOf(referer) : '')) {
          sendResponse({ error: 'rejected by capture rules' }); return;
        }
      }
      const headers = /^magnet:/i.test(url) ? [] : await buildHeaders(url, referer);
      const servers = resolveServers(c);
      const srv = routeServer(servers, url + (filename || '')) || defaultServer(servers);
      const extraOptions = sanitizeExternalOptions(msg.options);
      if (filename && !extraOptions.out) extraOptions.out = filename;
      await postTask(srv, url, { referer, headers, extraOptions });
      notify(i18n('sentToKimi'), filename || url);
      sendResponse({ ok: true });
    } catch (e) {
      try { sendResponse({ error: String(e.message || e) }); } catch {}
    }
  })();
  return true;
});

// ============================================================
// Badge（alarms 30s 轮询）+ 完成通知（WebSocket 事件）
// badge 共存策略：有活跃任务 → 全局任务数（靛蓝）；无任务 → 各 tab 嗅探媒体数（绿色 #16a34a）
// ============================================================
let lastActiveTasks = 0;

function clearSniffBadges() {
  for (const tabId of sniffedMedia.keys()) {
    try { chrome.action.setBadgeText({ text: '', tabId }); } catch {}
  }
}

function updateSniffBadge(tabId) {
  if (lastActiveTasks > 0) return; // 活跃任务数优先显示
  const n = sniffedMedia.get(tabId)?.size || 0;
  try {
    chrome.action.setBadgeText({ text: n ? String(n) : '', tabId });
    if (n) chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId });
  } catch {}
}

async function refreshBadge() {
  const c = await cfg();
  if (!c.enabled) {
    lastActiveTasks = 0;
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#9ca3af' });
    return;
  }
  const srv = defaultServer(resolveServers(c));
  try {
    const h = {};
    if (srv.token) h['Authorization'] = 'Bearer ' + srv.token;
    const res = await fetch(srv.url.replace(/\/+$/, '') + '/api/v1/stats', { headers: h });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    lastActiveTasks = s.numActive || 0;
    if (lastActiveTasks > 0) {
      chrome.action.setBadgeText({ text: String(lastActiveTasks) });
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
      clearSniffBadges(); // tab 级 badge 会覆盖全局，需清掉让任务数生效
    } else {
      chrome.action.setBadgeText({ text: '' });
      for (const tabId of sniffedMedia.keys()) updateSniffBadge(tabId);
    }
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  }
}

chrome.alarms.create('kimi-badge', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'kimi-badge') refreshBadge(); });
chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

// WebSocket 事件 → 完成/失败通知（Chrome 116+ 上 WS 活动可延长 Service Worker 存活）
let ws = null;
let eventsGeneration = 0;
let eventsReconnectTimer = null;
async function connectEvents() {
  const generation = ++eventsGeneration;
  clearTimeout(eventsReconnectTimer);
  eventsReconnectTimer = null;
  if (ws) {
    ws.onclose = ws.onmessage = ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  const c = await cfg();
  if (generation !== eventsGeneration || !c.notifyComplete) return;
  const srv = defaultServer(resolveServers(c));
  let wsUrl = srv.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  if (srv.token) wsUrl += '?token=' + encodeURIComponent(srv.token);
  let socket;
  try { socket = ws = new WebSocket(wsUrl); } catch { return; }
  socket.onmessage = async (ev) => {
    try {
      if (generation !== eventsGeneration) return;
      const m = JSON.parse(ev.data);
      if (m.type !== 'event') return;
      if (m.name === 'onDownloadComplete' || m.name === 'onBtComplete' || m.name === 'onDownloadError') {
        let name = m.gid || '';
        try {
          const h = {};
          if (srv.token) h['Authorization'] = 'Bearer ' + srv.token;
          const r = await fetch(srv.url.replace(/\/+$/, '') + '/api/v1/tasks/aria2/' + m.gid, { headers: h });
          if (r.ok) name = (await r.json()).name || name;
        } catch {}
        if (generation !== eventsGeneration) return;
        const ok = m.name !== 'onDownloadError';
        notify(ok ? i18n('taskComplete') : i18n('taskError'), name);
      }
    } catch {}
  };
  socket.onclose = () => {
    if (generation === eventsGeneration) eventsReconnectTimer = setTimeout(connectEvents, 10000);
  };
  socket.onerror = () => { try { socket.close(); } catch {} };
}
connectEvents();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.notifyComplete || changes.serverUrl || changes.apiToken || changes.servers) connectEvents();
  if (changes.sniffEnabled) sniffEnabledCache = changes.sniffEnabled.newValue !== false;
  if (changes.sniffRegexRules) sniffRulesCache = Array.isArray(changes.sniffRegexRules.newValue) ? changes.sniffRegexRules.newValue : [];
  if (changes.deepSearch) deepSearchCache = !!changes.deepSearch.newValue;
  if (changes.panelOpenStyle) applyPanelStyle(changes.panelOpenStyle.newValue);
  // 语言切换：重建右键菜单（createMenus 内部会先 loadI18nOverride）并重连事件流（通知文案用新语言）
  if (changes.locale) {
    try { createMenus(); } catch (e) {}
    try { connectEvents(); } catch (e) {}
  }
});

refreshBadge();
