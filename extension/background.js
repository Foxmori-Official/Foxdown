// Foxdown Connector - 后台服务脚本 v3.1
// v2.0: 融合 Aria2-Explorer（cookies API 兜底、过滤优先级、Alt 旁路、磁力点击拦截）
//       与 Gopeed browser-extension（webRequest 精确请求头捕获、pause→cancel/resume 接管流程）的优点
// v3.0 新增：
//   1) 网页流媒体嗅探（参考 cat-catch：onResponseStarted + onSendHeaders 按 requestId 配对 + onErrorOccurred 清理）
//   2) 多服务器 URL 路由（参考 Aria2-Explorer getRpcServer/rpcList 模式）
//   3) 第三方扩展中间件 API（参考 Aria2-Explorer externally_connectable + onMessageExternal 模式）
// v3.1 新增（融合 cat-catch 核心能力）：
//   1) 深度搜索 deepSearch（在页面主上下文扫描 script 文本/播放器全局变量）
//   2) 嗅探正则过滤 sniffRegexRules（cat-catch init.js wildcardToRegex 方案）
//   3) 文件名模板 fileNameTemplate（cat-catch templates.js 变量体系精简版）
//   4) 自动下载嗅探媒体 autoDownloadSniffed + 体积阈值（Set 防重复）
// v3.2 新增（参考 Aria2-Explorer askBeforeDownload + webUIOpenStyle）：
//   1) 下载前参数确认弹窗 askBeforeDownload：pause 后挂起浏览器下载，
//      弹 popup.html?mode=confirm 确认文件名/分片/目标服务器，确认发送、取消恢复
//   2) 管理面板多形态 panelOpenStyle：popup/newtab/window/sidepanel，
//      非 popup 形态运行时 chrome.action.setPopup({popup:''}) 清空，图标点击走 onClicked 分发

// 共享纯函数（lib.js）：wildcardToRegex / matchSniffRegexRules /
// renderFileNameTemplate / shouldAutoDownload / scanDeepSearch
// 手动语言切换覆盖层（i18n.js）：全局 i18n() / loadI18nOverride()
// 测试环境已在同一上下文预加载 lib.js，importScripts 失败可忽略
try { importScripts('lib.js'); } catch (e) {}
importScripts('settings.js');
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
  return readSettings(DEFAULTS);
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
  return hit && Date.now() - hit.ts <= HEADER_TTL ? hit.headers : null;
}

function sweepRequestHeaders() {
  const now = Date.now();
  for (const [k, v] of requestHeaderMap) if (now - v.ts > HEADER_TTL) requestHeaderMap.delete(k);
  for (const [k, v] of sniffHeaderMap) if (now - v.ts > HEADER_TTL) sniffHeaderMap.delete(k);
}

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
async function postTask(server, url, { referer, headers, extraOptions, reuseActive } = {}) {
  await failureReady;
  pendingSends++;
  void paintBadge();
  try {
    const h = { 'Content-Type': 'application/json' };
    if (server.token) h.Authorization = 'Bearer ' + server.token;
    const options = { ...(extraOptions || {}) };
    if (referer && referer !== 'about:blank') options.referer = referer;
    if (headers?.length) options.headers = headers;
    const body = { url, options };
    if (reuseActive) body.reuseActive = true;
    const res = await fetch(server.url.replace(/\/+$/, '') + '/api/v1/tasks', {
      method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const result = await res.json();
    if (handoffFailure?.url === url) {
      handoffFailure = null;
      await chrome.storage.session.remove('foxdown-handoff-error').catch(() => {});
    }
    return result;
  } catch (error) {
    handoffFailure = { url, name: extraOptions?.out || url, error: String(error.message || error) };
    await chrome.storage.session.set({ 'foxdown-handoff-error': handoffFailure }).catch(() => {});
    throw error;
  } finally {
    pendingSends--;
    void refreshBadge();
    void paintBadge();
  }
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

async function sendToKimi(url, { referer, filename, headersOverride, extraOptions, pageTitle, reuseActive } = {}) {
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
  const result = await postTask(srv, url, { referer, headers, extraOptions: opts, reuseActive });
  if (!result.reused) notify(i18n('sentToKimi'), filename || opts.out || url);
  return result;
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
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'rdown-pending-cleanup') return;
  sweepRequestHeaders();
  void sweepPendingConfirms().catch(() => {});
});

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

async function openConfirmation(token, mode = 'confirm') {
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html') + '?mode=' + mode + '&token=' + token,
    type: 'popup', width: mode === 'batch' ? 560 : 360, height: 520, focused: true,
  });
  const entry = pendingConfirms.get(token);
  if (!entry || win?.id == null) return;
  entry.windowId = win.id;
  await chrome.storage.session?.set({ [PENDING_KEY_PREFIX + token]: entry });
  if (chrome.windows.get) {
    try { await chrome.windows.get(win.id); } catch { await cancelPendingDownload(token); }
  }
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
  if (entry?.urls) return { error: 'invalid download confirmation' };
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
  'flv', 'flac', 'ogg', 'ogv', 'webm', 'mkv', 'avi', 'mov', 'wav',
  'm3u', 'mpeg', 'mpg', 'wmv', 'asf', 'opus', 'weba', 'wma',
]);
const MEDIA_CT_RE = /mpegurl|dash\+xml|^video\/|^audio\/|^application\/(?:ogg|m4s)$/;
const sniffHeaderMap = new Map();   // requestId -> { headers, ts }
const sniffedMedia = new Map();     // tabId -> Map<url, {url, type, size, contentType, filename, headers, ts, source}>
const SNIFF_HDR_MAX = 5000;
const SNIFF_MAX_PER_TAB = 200;
let sniffEnabledCache = true;
let sniffRulesCache = [];           // sniffRegexRules 缓存（[{url, state}]）
let deepSearchCache = false;        // deepSearch 自动执行开关缓存
const autoSentSet = new Set();      // 自动下载防重复：同一 URL 只自动发一次
const autoSending = new Set();
const MEDIA_KEY_PREFIX = 'foxdown-media-';
const AUTO_SENT_KEY = 'foxdown-auto-sent';
const deepSearches = new Map();

const mediaRestore = (async () => {
  const entries = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(entries)) {
    if (!Array.isArray(value)) continue;
    if (key === AUTO_SENT_KEY) {
      for (const url of value) autoSentSet.add(url);
    } else if (key.startsWith(MEDIA_KEY_PREFIX)) {
      const tabId = Number(key.slice(MEDIA_KEY_PREFIX.length));
      sniffedMedia.set(tabId, new Map(value.map(entry => [entry.url, entry])));
    }
  }
})().catch(() => {});

function saveTabMedia(tabId) {
  const key = MEDIA_KEY_PREFIX + tabId;
  const tab = sniffedMedia.get(tabId);
  const operation = tab?.size ? chrome.storage.session.set({ [key]: [...tab.values()] }) : chrome.storage.session.remove(key);
  void operation.catch(() => {});
}

function clearTabMedia(tabId) {
  deepSearches.delete(tabId);
  for (const [id, entry] of sniffHeaderMap) if (entry.tabId === tabId) sniffHeaderMap.delete(id);
  void mediaRestore.then(() => {
    sniffedMedia.delete(tabId);
    saveTabMedia(tabId);
    updateSniffBadge();
  });
}

const sniffConfigReady = cfg().then(c => {
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
    else if (n === 'content-disposition') {
      const value = h.value || '';
      const encoded = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
      const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
      const name = encoded || plain?.[1] || plain?.[2] || '';
      try { out.filename = decodeURIComponent(name.trim().replace(/^"|"$/g, '')); }
      catch { out.filename = name.trim(); }
      out.attachment = /^attachment(?:;|$)/i.test(value.trim());
    }
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
    const headers = hit && Date.now() - hit.ts <= HEADER_TTL ? hit.headers : undefined;
    void Promise.all([mediaRestore, sniffConfigReady]).then(() => {
      if (sniffEnabledCache) sniffFindMedia(details, headers);
    }).catch(() => {});
  } catch {}
}

function sniffOnErrorOccurred(details) {
  sniffHeaderMap.delete(details.requestId);
}

function sniffFindMedia(details, reqHeaders) {
  // 排除：OPTIONS 预检、非标签页请求、非 http(s)、扩展（含自身）发起的请求
  if (details.method === 'OPTIONS') return;
  if (details.statusCode >= 400) return;
  if (details.tabId == null || details.tabId < 0) return;
  const url = details.url || '';
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;

  const resp = sniffParseResponseHeaders(details.responseHeaders);
  const suffix = resp.filename?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase();
  const m = sniffMatch(url, resp.type, details.type) ||
    (MEDIA_EXTS.has(suffix) || (resp.attachment && resp.filename) ? { ext: suffix || 'file' } : null);
  if (!m) return;
  // 嗅探正则过滤（cat-catch 方案）：规则非空时仅命中 state=true 规则的 URL 进列表
  if (!matchSniffRegexRules(sniffRulesCache, url)) return;

  let tab = sniffedMedia.get(details.tabId);
  if (!tab) { tab = new Map(); sniffedMedia.set(details.tabId, tab); }
  if (tab.get(url)?.source === 'network') return; // Network headers replace a deep-search candidate.
  if (tab.size >= SNIFF_MAX_PER_TAB) tab.delete(tab.keys().next().value); // 淘汰最旧

  let filename = '';
  try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); }
  catch { filename = new URL(url).pathname.split('/').pop() || ''; }
  const entry = {
    url,
    type: mediaTypeLabel(m.ext, resp.type),
    size: resp.size || 0,
    contentType: resp.type || '',
    filename: resp.filename || filename || url,
    headers: filterSniffHeaders(reqHeaders),
    ts: Date.now(),
    source: 'network'
  };
  tab.set(url, entry);
  saveTabMedia(details.tabId);
  updateSniffBadge(details.tabId);
  maybeAutoDownload(entry);
}

// ============================================================
// 深度搜索仅提供候选链接。未经过网络嗅探的候选项不会触发自动下载。
// ============================================================
function addDeepSearchMedia(tabId, urls, pageHref) {
  if (!sniffEnabledCache || !Array.isArray(urls)) return 0;
  let added = 0;
  for (const url of urls.slice(0, SNIFF_MAX_PER_TAB)) {
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
  }
  if (added) {
    saveTabMedia(tabId);
    updateSniffBadge(tabId);
  }
  return added;
}

function searchTab(tabId) {
  if (deepSearches.has(tabId)) return deepSearches.get(tabId);
  const search = (async () => {
    await mediaRestore;
    const [scan] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: scanDeepSearch });
    if (deepSearches.get(tabId) === search && scan?.result) {
      addDeepSearchMedia(tabId, scan.result.urls, scan.result.href);
    }
  })().finally(() => {
    if (deepSearches.get(tabId) === search) deepSearches.delete(tabId);
  });
  deepSearches.set(tabId, search);
  return search;
}

// ============================================================
// 自动下载嗅探媒体：体积 ≥ 阈值才发送；m3u8 直播流（体积未知）跳过；
// 同一 URL 只自动发一次（autoSentSet 防重复）
// ============================================================
async function maybeAutoDownload(media) {
  await mediaRestore;
  const c = await cfg().catch(() => null);
  if (!shouldAutoDownload(media, c, autoSentSet) || autoSending.has(media.url)) return;
  autoSending.add(media.url);
  try {
    const headers = sniffHeadersToLines(media.headers);
    const result = await sendToKimi(media.url, {
      referer: media.headers?.referer,
      filename: media.filename,
      headersOverride: headers,
      reuseActive: true
    });
    autoSentSet.add(media.url);
    if (autoSentSet.size > 1000) autoSentSet.delete(autoSentSet.values().next().value);
    await chrome.storage.session.set({ [AUTO_SENT_KEY]: [...autoSentSet] }).catch(() => {});
    if (!result.reused) notify(i18n('autoDownloaded'), media.filename || media.url);
  } catch (e) {
    notify(i18n('sendFailed'), String(e.message || e));
  } finally {
    autoSending.delete(media.url);
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
chrome.tabs.onRemoved?.addListener(clearTabMedia);
// 深度搜索自动执行：选项页开启 deepSearch 后，在页面加载完成时扫描
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    clearTabMedia(tabId);
  }
  if (changeInfo.status === 'complete' && deepSearchCache && sniffEnabledCache) {
    void searchTab(tabId).catch(() => {});
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
        await openConfirmation(token);
      } catch (e) {
        if (token) await removePendingConfirm(token);
        try { await chrome.downloads.resume(item.id); } catch {}
        notify(i18n('sendFailed'), String(e.message || e));
      }
      return;
    }
    try {
      await sendToKimi(url, { referer: item.referrer, filename: item.filename, reuseActive: true });
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
  { id: 'kimi-page', key: 'menuPage', contexts: ['page'] },
  { id: 'foxdown-selection', key: 'menuSel', contexts: ['selection'] },
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
    try {
      const urls = await chrome.tabs.sendMessage(tab.id, { type: 'kimi-collect-links' });
      await confirmPageLinks(urls, info.pageUrl);
    } catch (error) { notify(i18n('menuPage'), String(error.message || error)); }
  } else if (info.menuItemId === 'foxdown-selection') {
    const urls = (info.selectionText || '').match(/(?:https?:\/\/|magnet:\?)[^\s<>"']+/gi) || [];
    try { await confirmPageLinks(urls.map(url => url.replace(/[.,;，。；]+$/, '')), info.pageUrl); }
    catch (error) { notify(i18n('menuSel'), String(error.message || error)); }
  }
});

async function confirmPageLinks(links, referer) {
  const c = await cfg();
  const pageHost = hostOf(referer);
  const urls = [...new Set(Array.isArray(links) ? links : [])].filter(url => {
    if (typeof url !== 'string') return false;
    if (/^magnet:\?/i.test(url)) return c.captureMagnet;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      return shouldCapture(c, { url, filename: parsed.pathname.split('/').pop() }, pageHost);
    } catch { return false; }
  });
  if (!urls.length) { notify(i18n('batchChoose'), i18n('noLinksFound')); return; }
  const token = await addPendingConfirm({ urls, referer });
  try {
    await openConfirmation(token, 'batch');
  } catch (error) {
    await removePendingConfirm(token);
    throw error;
  }
}

function submitPageLinks(token, selected) {
  return pendingOperation(token, async () => {
    const entry = await getPendingConfirm(token);
    if (!entry?.urls) return { error: 'expired' };
    const urls = [...new Set(selected)].filter(url => entry.urls.includes(url)).slice(0, 5);
    const servers = resolveServers(await cfg());
    const results = await Promise.allSettled(urls.map(async url => {
      const headers = /^magnet:\?/i.test(url) ? [] : await buildHeaders(url, entry.referer);
      await postTask(routeServer(servers, url) || defaultServer(servers), url, { referer: entry.referer, headers });
    }));
    const sent = urls.filter((_, index) => results[index].status === 'fulfilled');
    entry.urls = entry.urls.filter(url => !sent.includes(url));
    entry.ts = Date.now();
    await chrome.storage.session?.set({ [PENDING_KEY_PREFIX + token]: entry }).catch(() => {});
    return { sent };
  });
}

// ============================================================
// 快捷键
// ============================================================
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'toggle-capture') {
    const c = await cfg();
    await writeSettings({ enabled: !c.enabled });
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
  if (msg?.type === 'getCapturePreferences') {
    readSettings({ enabled: true, captureMagnet: true }).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg?.type === 'getDownloadStatus') {
    void refreshBadge().then(() => sendResponse(downloadStatus()));
    return true;
  }
  if (msg?.type === 'clearHandoffError') {
    handoffFailure = null;
    void chrome.storage.session.remove('foxdown-handoff-error').then(() => {
      void paintBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
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
    void mediaRestore.then(() => sendResponse([...(sniffedMedia.get(msg.tabId)?.values() || [])]));
    return true;
  }
  // popup"深度搜索"按钮
  if (msg?.type === 'triggerDeepSearch' && msg.tabId != null) {
    searchTab(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  // popup 点击下载某个嗅探到的媒体（带嗅探时捕获的请求头）
  if (msg?.type === 'downloadSniffed' && msg.url) {
    (async () => {
      try {
        await mediaRestore;
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
        if (entry.urls) { sendResponse({ urls: entry.urls }); return; }
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
  if (msg?.type === 'submitPageLinks' && msg.token && Array.isArray(msg.urls)) {
    submitPageLinks(msg.token, msg.urls).then(sendResponse, error => sendResponse({ error: String(error.message || error) }));
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
const EXTERNAL_OPTION_KEYS = ['userAgent', 'cookie', 'split', 'maxConnectionPerServer', 'selectFile', 'seedTime'];

function externalFilename(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name || /^[.]|[.]$|[\\/:*?"<>|\x00-\x1f\x7f]/.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name)) return undefined;
  return name;
}

function sanitizeExternalOptions(src) {
  const out = {};
  for (const k of EXTERNAL_OPTION_KEYS) {
    if (src && src[k] !== undefined) out[k] = src[k];
  }
  const filename = externalFilename(src?.out);
  if (filename) out.out = filename;
  return out;
}

chrome.runtime.onMessageExternal?.addListener((msg, sender, sendResponse) => {
  if (!sender?.id) {
    sendResponse({ error: 'only other extensions can submit download requests' });
    return;
  }
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
      const filename = externalFilename(msg.filename);
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
// Badge priority: failed task > ongoing downloads > resources in this tab.
// Blue resource counts and green task counts also share a detailed tooltip.
const serverStates = new Map();
const renderedBadges = new Map();
let pendingSends = 0;
let handoffFailure = null;
let badgeRefresh = null;
let paintGeneration = 0;
let eventsGeneration = 0;
let eventsSockets = [];
let eventsReconnectTimer = null;
const failureReady = chrome.storage.session.get('foxdown-handoff-error').then(saved => {
  handoffFailure = saved['foxdown-handoff-error'] || null;
}).catch(() => {});

function serverKey(server) {
  return server.url.replace(/\/+$/, '') + '\n' + (server.token || '');
}

function taskServers(config) {
  const servers = new Map();
  for (const server of resolveServers(config)) servers.set(serverKey(server), server);
  return [...servers.values()];
}

function downloadStatus() {
  const tasks = [...serverStates.values()].flatMap(state => state.tasks || []);
  const active = tasks.filter(task => ['active', 'downloading', 'muxing'].includes(task.status)).length;
  const waiting = tasks.filter(task => task.status === 'waiting').length;
  const errors = tasks.filter(task => task.status === 'error');
  const unavailable = [...serverStates.values()].filter(state => state.unavailable).length;
  return { active, waiting, ongoing: Math.max(active + waiting, pendingSends), pending: pendingSends,
    errors: errors.map(task => ({ name: task.name || task.id, error: task.errorMessage || '' })),
    unavailable, handoffFailure };
}

async function paintBadge() {
  const generation = ++paintGeneration;
  await failureReady;
  const config = await cfg();
  const status = downloadStatus();
  const failed = status.errors.length || status.unavailable || status.handoffFailure;
  const text = failed ? 'X' : status.ongoing ? (status.ongoing > 999 ? '999+' : String(status.ongoing)) : config.enabled ? '' : 'OFF';
  const color = failed ? '#a34139' : status.ongoing ? '#2e5943' : '#6b756b';
  let title = 'Foxdown · ' + i18n('badgeSummary', [String(status.active), String(status.waiting), String(status.errors.length)]);
  if (status.handoffFailure) title += '\n' + i18n('handoffFailed') + ' · ' + status.handoffFailure.name;
  if (status.unavailable) title += '\n' + i18n('dashboardUnavailable');
  if (!config.enabled) title += '\n' + i18n('captureOff');
  const tabs = await chrome.tabs.query({}).catch(() => []);
  if (generation !== paintGeneration) return;
  const targets = [{}, ...tabs.filter(tab => tab.id >= 0).map(tab => ({ tabId: tab.id }))];
  for (const target of targets) {
    const media = sniffedMedia.get(target.tabId)?.size || 0;
    const resourceBadge = !failed && !status.ongoing && media > 0;
    const badgeText = resourceBadge ? (media > 999 ? '999+' : String(media)) : text;
    const badgeColor = resourceBadge ? '#2563eb' : color;
    const caption = title + (media ? '\n' + i18n('pageResourcesCount', String(media)) : '');
    const signature = JSON.stringify([badgeText, badgeColor, caption]);
    const key = target.tabId ?? 'global';
    if (renderedBadges.get(key) === signature) continue;
    renderedBadges.set(key, signature);
    await Promise.allSettled([
      chrome.action.setBadgeText({ ...target, text: badgeText }),
      chrome.action.setBadgeBackgroundColor({ ...target, color: badgeColor }),
      chrome.action.setBadgeTextColor?.({ ...target, color: '#ffffff' }),
      chrome.action.setTitle?.({ ...target, title: caption }),
    ]);
    if (generation !== paintGeneration) return;
  }
}

function updateSniffBadge() {
  void paintBadge().catch(() => {});
}

function refreshBadge() {
  if (badgeRefresh) return badgeRefresh;
  const generation = eventsGeneration;
  badgeRefresh = (async () => {
    const servers = taskServers(await cfg());
    const keys = new Set(servers.map(serverKey));
    for (const key of serverStates.keys()) if (!keys.has(key)) serverStates.delete(key);
    await Promise.all(servers.map(async server => {
      const key = serverKey(server);
      const previous = serverStates.get(key);
      try {
        const response = await fetch(server.url.replace(/\/+$/, '') + '/api/v1/tasks', {
          headers: server.token ? { Authorization: 'Bearer ' + server.token } : {},
          signal: AbortSignal.timeout(6000), redirect: 'error',
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (!Array.isArray(result.tasks)) throw new Error('Invalid task list');
        if (generation === eventsGeneration && serverStates.get(key) === previous) {
          serverStates.set(key, { tasks: result.tasks, unavailable: false });
        }
      } catch {
        if (generation === eventsGeneration && serverStates.get(key) === previous) {
          serverStates.set(key, { tasks: previous?.tasks || [], unavailable: true });
        }
      }
    }));
    await paintBadge();
  })().catch(() => {}).finally(() => {
    badgeRefresh = null;
    if (generation !== eventsGeneration) void refreshBadge();
  });
  return badgeRefresh;
}

chrome.alarms.create('kimi-badge', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'kimi-badge') void refreshBadge(); });
chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.tabs.onActivated?.addListener(() => { void paintBadge(); });
chrome.tabs.onRemoved?.addListener(tabId => { renderedBadges.delete(tabId); });

async function connectEvents() {
  const generation = ++eventsGeneration;
  clearTimeout(eventsReconnectTimer);
  for (const socket of eventsSockets) {
    socket.onclose = socket.onmessage = socket.onerror = null;
    try { socket.close(); } catch {}
  }
  eventsSockets = [];
  const config = await cfg();
  if (generation !== eventsGeneration) return;
  const servers = taskServers(config);
  const keys = new Set(servers.map(serverKey));
  for (const key of serverStates.keys()) if (!keys.has(key)) serverStates.delete(key);
  for (const server of servers) {
    const key = serverKey(server);
    let url = server.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    if (server.token) url += '?token=' + encodeURIComponent(server.token);
    let socket;
    try { socket = new WebSocket(url); } catch { continue; }
    eventsSockets.push(socket);
    socket.onmessage = async event => {
      if (generation !== eventsGeneration) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state' && Array.isArray(message.tasks)) {
          serverStates.set(key, { tasks: message.tasks, unavailable: false });
          void paintBadge();
          return;
        }
        if (message.type !== 'event') return;
        void refreshBadge();
        const isResult = ['onDownloadComplete', 'onBtComplete', 'onDownloadError'].includes(message.name);
        if (!isResult || !(await cfg()).notifyComplete) return;
        let name = message.gid || '';
        try {
          const response = await fetch(server.url.replace(/\/+$/, '') + '/api/v1/tasks/aria2/' + message.gid, {
            headers: server.token ? { Authorization: 'Bearer ' + server.token } : {},
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) name = (await response.json()).name || name;
        } catch {}
        if (generation === eventsGeneration) notify(i18n(message.name === 'onDownloadError' ? 'taskError' : 'taskComplete'), name);
      } catch {}
    };
    socket.onclose = () => {
      if (generation !== eventsGeneration) return;
      serverStates.set(key, { tasks: serverStates.get(key)?.tasks || [], unavailable: true });
      void paintBadge();
      clearTimeout(eventsReconnectTimer);
      eventsReconnectTimer = setTimeout(connectEvents, 10000);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }
  void refreshBadge();
}
void connectEvents();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.serverUrl || changes.apiToken || changes.servers) void connectEvents();
  if (changes.sniffEnabled) sniffEnabledCache = changes.sniffEnabled.newValue !== false;
  if (changes.sniffRegexRules) sniffRulesCache = Array.isArray(changes.sniffRegexRules.newValue) ? changes.sniffRegexRules.newValue : [];
  if (changes.deepSearch) deepSearchCache = !!changes.deepSearch.newValue;
  if (changes.panelOpenStyle) applyPanelStyle(changes.panelOpenStyle.newValue);
  if (changes.locale) {
    void createMenus();
    void loadI18nOverride().then(paintBadge);
  } else void paintBadge();
});

void refreshBadge();
void loadI18nOverride().then(paintBadge).catch(() => {});

// Preview requests may reuse the Referer captured for that media. A session
// rule is limited to this extension, the preview tab, and the media origin.
const previewRulesReady = chrome.declarativeNetRequest?.getSessionRules().then(rules => {
  if (rules.length) return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
}).catch(() => {});
let nextPreviewRule = 1;

chrome.runtime.onConnect?.addListener(port => {
  if (port.name !== 'foxdown-media-preview' ||
      port.sender?.url?.split('?')[0] !== chrome.runtime.getURL('popup.html')) return;
  const id = nextPreviewRule++;
  let closed = false;
  let installed = false;
  let update;
  port.onMessage.addListener(({ tabId, url }) => {
    if (update) return;
    update = (async () => {
      await previewRulesReady;
      await mediaRestore;
      if (closed) return;
      const media = sniffedMedia.get(tabId)?.get(url);
      const referer = media?.source === 'network' && media.headers?.referer;
      if (referer && /^https?:\/\//i.test(referer)) {
        const target = new URL(url);
        target.hash = '';
        const hls = media.type === 'HLS';
        const pattern = hls ? target.origin + '/' : target.href;
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await chrome.declarativeNetRequest.updateSessionRules({
          addRules: [{
            id,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
            condition: {
              regexFilter: '^' + escaped + (hls ? '' : '$'),
              isUrlFilterCaseSensitive: true,
              initiatorDomains: [chrome.runtime.id],
              tabIds: [port.sender.tab?.id ?? chrome.tabs.TAB_ID_NONE],
              resourceTypes: ['media', 'xmlhttprequest'],
            },
          }],
        });
        installed = true;
      }
    })().catch(() => {}).then(() => {
      if (!closed) { try { port.postMessage({ ready: true }); } catch {} }
    });
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    void update?.then(() => {
      if (installed) return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    }).catch(() => {});
  });
});
