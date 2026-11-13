// 扩展核心逻辑测试：mock chrome API，加载 background.js，测试过滤/通配/请求头逻辑
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

// ---- chrome API mock ----
const listeners = {};
const storageData = {};
const sessionData = {};
// 调用记录（新增 API 的行为断言用）
const calls = {
  windowsCreate: [], tabsCreate: [], setPopup: [], sidePanelOpen: [], sidePanelOptions: [],
  downloadsPause: [], downloadsCancel: [], downloadsResume: [], downloadsErase: [], fetch: [],
};
let fetchImpl = null; // 测试可注入的 fetch 实现
const chrome = {
  storage: {
    local: {
      get: async (defaults) => ({ ...defaults, ...storageData }),
      set: async (obj) => Object.assign(storageData, obj),
    },
    session: {
      get: async (key) => (typeof key === 'string' ? { [key]: sessionData[key] } : { ...sessionData }),
      set: async (obj) => Object.assign(sessionData, obj),
      remove: async (key) => { delete sessionData[key]; },
    },
    onChanged: { addListener: () => {} },
  },
  downloads: {
    onDeterminingFilename: { addListener: (fn) => { listeners.onDeterminingFilename = fn; } },
    pause: async (id) => { calls.downloadsPause.push(id); },
    cancel: async (id) => { calls.downloadsCancel.push(id); },
    resume: async (id) => { calls.downloadsResume.push(id); },
    erase: (q) => { calls.downloadsErase.push(q); },
  },
  webRequest: {
    onBeforeSendHeaders: { addListener: (fn, filter, extra) => { listeners.onBeforeSendHeaders = fn; } },
  },
  cookies: {
    getAll: async ({ url, partitionKey }) => {
      if (partitionKey !== undefined) return []; // 分区查询
      return [{ name: 'session', value: 'abc123' }, { name: 'uid', value: '42' }];
    },
  },
  contextMenus: { removeAll: () => {}, create: () => {}, onClicked: { addListener: () => {} } },
  runtime: {
    id: 'test-ext-id',
    onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
    onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
    getURL: (p) => 'chrome-extension://test/' + p,
  },
  notifications: { create: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  action: {
    setBadgeText: () => {}, setBadgeBackgroundColor: () => {},
    setPopup: (o) => { calls.setPopup.push(o); },
    onClicked: { addListener: (fn) => { listeners.actionOnClicked = fn; } },
  },
  windows: { create: async (props) => { calls.windowsCreate.push(props); return { id: 100 + calls.windowsCreate.length }; } },
  sidePanel: {
    setOptions: async (o) => { calls.sidePanelOptions.push(o); },
    open: async (o) => { calls.sidePanelOpen.push(o); },
  },
  commands: { onCommand: { addListener: () => {} } },
  i18n: { getMessage: (k) => k },
  tabs: { query: async () => [], create: (o) => { calls.tabsCreate.push(o); return Promise.resolve({ id: 1 }); }, sendMessage: async () => [] },
};

const sandbox = {
  chrome, console, importScripts: () => {},
  readSettings: defaults => chrome.storage.local.get(defaults),
  writeSettings: patch => chrome.storage.local.set(patch),
  setInterval, setTimeout, clearInterval, clearTimeout,
  navigator: { userAgent: 'Mozilla/5.0 TestAgent' },
  URL, Map, Set, Date, JSON, RegExp, Promise, AbortSignal,
  fetch: async (...args) => {
    if (args[1]?.method !== 'POST') return { ok: true, json: async () => ({ tasks: [] }) };
    calls.fetch.push(args);
    if (fetchImpl) return fetchImpl(...args);
    throw new Error('no fetch in test');
  },
  WebSocket: class { constructor() { throw new Error('no ws in test'); } },
};
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const libCode = fs.readFileSync(path.join(EXT, 'lib.js'), 'utf8');
vm.runInContext(libCode + '\n' + code + '\n;globalThis.__test = { shouldCapture, matchWildcard, buildHeaders, storeRequestHeaders, consumeRequestHeaders, routeServer, resolveServers, defaultServer, sniffMatch, sanitizeExternalOptions, wildcardToRegex, matchSniffRegexRules, renderFileNameTemplate, shouldAutoDownload, scanDeepSearch, addDeepSearchMedia, maybeAutoDownload, sniffedMedia, autoSentSet, pendingConfirms, addPendingConfirm, getPendingConfirm, removePendingConfirm, resolveConfirmServers, confirmPendingDownload, cancelPendingDownload, normalizePanelStyle, applyPanelStyle, openPanel };', sandbox);
const T = sandbox.__test;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
// 轮询等待异步监听流程落地（onDeterminingFilename 等不返回 Promise 的监听器）
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
};
const baseCfg = (over = {}) => ({
  ...DEFAULTS_SAFE, enabled: true, domainMode: 'off', domainList: '', extMode: 'off', extList: '',
  minSizeMB: 0, captureUnknownSize: true, ...over,
});
const DEFAULTS_SAFE = {};
const item = (over = {}) => ({ url: 'https://a.com/f.zip', finalUrl: 'https://a.com/f.zip', filename: 'f.zip', totalBytes: 100 * 1048576, ...over });

console.log('== matchWildcard ==');
assert(T.matchWildcard('dl.baidu.com', '*.baidu.com'), '*.baidu.com 匹配子域名');
assert(T.matchWildcard('baidu.com', 'baidu.com'), '精确域名匹配');
assert(!T.matchWildcard('baidu.com.evil.com', '*.baidu.com'), '不匹配的域名拒绝');
assert(T.matchWildcard('a.com', '*'), '单星 * 匹配一切');

console.log('== shouldCapture ==');
assert(T.shouldCapture(baseCfg(), item()), '默认配置接管普通文件');
assert(!T.shouldCapture(baseCfg(), item({ byExtensionId: 'test-ext-id' })), '防自捕获（byExtensionId）');
assert(T.shouldCapture(baseCfg(), item({ url: 'https://a.com/x.m3u8', filename: '' })), 'm3u8 始终接管');
assert(T.shouldCapture(baseCfg(), item({ url: 'https://a.com/x.mpd?token=1', filename: '' })), 'mpd 带参数接管');
assert(!T.shouldCapture(baseCfg(), item({ url: 'magnet:?xt=urn:btih:xx', finalUrl: 'magnet:?xt=urn:btih:xx', filename: '' })), 'magnet 不走 downloads 接管');
assert(!T.shouldCapture(baseCfg({ domainMode: 'blacklist', domainList: '*.a.com' }), item()), '域名黑名单排除（顶级域）');
assert(!T.shouldCapture(baseCfg({ domainMode: 'blacklist', domainList: '*.a.com' }), item({ url: 'https://dl.a.com/f.zip', finalUrl: 'https://dl.a.com/f.zip' })), '域名黑名单排除（子域）');
assert(T.shouldCapture(baseCfg({ domainMode: 'blacklist', domainList: '*.b.com' }), item()), '域名黑名单不影响其他站');
assert(T.shouldCapture(baseCfg({ domainMode: 'whitelist', domainList: '*.a.com' }), item()), '域名白名单接管');
assert(!T.shouldCapture(baseCfg({ domainMode: 'whitelist', domainList: '*.b.com' }), item()), '域名白名单排除其他');
assert(T.shouldCapture(baseCfg({ extMode: 'whitelist', extList: 'zip, exe' }), item()), '后缀白名单命中');
assert(!T.shouldCapture(baseCfg({ extMode: 'whitelist', extList: 'zip, exe' }), item({ filename: 'f.pdf', url: 'https://a.com/f.pdf' })), '后缀白名单未命中');
assert(!T.shouldCapture(baseCfg({ extMode: 'blacklist', extList: '.zip' }), item()), '后缀黑名单排除（带点写法）');
assert(!T.shouldCapture(baseCfg({ minSizeMB: 200 }), item()), '小于最小大小不接管');
assert(T.shouldCapture(baseCfg({ minSizeMB: 50 }), item()), '大于最小大小接管');
assert(T.shouldCapture(baseCfg({ minSizeMB: 10, captureUnknownSize: true }), item({ totalBytes: 0, fileSize: -1 })), '未知大小+允许=接管');
assert(!T.shouldCapture(baseCfg({ minSizeMB: 10, captureUnknownSize: false }), item({ totalBytes: 0, fileSize: -1 })), '未知大小+禁止=不接管');

console.log('== 请求头组装 ==');
// 1. webRequest 捕获优先
T.storeRequestHeaders({
  url: 'https://a.com/f.zip',
  requestHeaders: [
    { name: 'Cookie', value: 'cap=1' },
    { name: 'User-Agent', value: 'CapAgent/9.9' },
    { name: 'Referer', value: 'https://a.com/page' },
  ],
});
let headers = await T.buildHeaders('https://a.com/f.zip', 'https://a.com/page');
assert(headers.some(h => h === 'Cookie: cap=1'), 'webRequest 捕获的 Cookie 优先');
assert(headers.some(h => h === 'User-Agent: CapAgent/9.9'), '捕获的 UA 优先');
assert(headers.some(h => h === 'Referer: https://a.com/page'), '捕获的 Referer 优先');
// 2. 无捕获时 cookies API 兜底
headers = await T.buildHeaders('https://b.com/g.zip', 'https://b.com/');
assert(headers.some(h => h === 'Cookie: session=abc123; uid=42'), 'cookies API 兜底');
assert(headers.some(h => h.startsWith('User-Agent: Mozilla/5.0 TestAgent')), 'UA 兜底 navigator');
assert(headers.some(h => h === 'Referer: https://b.com/'), 'referrer 参数兜底');
// 3. 无 referer 时不加 Referer
headers = await T.buildHeaders('https://c.com/h.zip', 'about:blank');
assert(!headers.some(h => h.startsWith('Referer:')), 'about:blank referer 被忽略');

console.log('== 多服务器路由（routeServer / resolveServers / defaultServer）==');
const servers = [
  { name: 'A', url: 'http://a:6800', token: '', pattern: '*' },
  { name: 'B', url: 'http://b:6800', token: '', pattern: '*pan.baidu.com*, *dl.baidu.com*' },
  { name: 'C', url: 'http://c:6800', token: '', pattern: '*youtube.com*mp4*' },
];
assert(T.routeServer(servers, 'https://pan.baidu.com/s/xxf.zip').name === 'B', '通配符规则命中对应服务器');
assert(T.routeServer(servers, 'https://dl.baidu.com/f.zipf.zip').name === 'B', '逗号分隔第二条规则也命中');
assert(T.routeServer(servers, 'https://a.com/f.zipf.zip').name === 'A', '未命中走 * 默认服务器');
assert(T.routeServer(servers, 'https://www.youtube.com/v.mp4v.mp4').name === 'C', '多段通配符命中');
// 首个命中者优先：B 与 C 都能匹配时取排前面的
const serversBC = [
  { name: 'B', url: 'http://b', token: '', pattern: '*video*' },
  { name: 'C', url: 'http://c', token: '', pattern: '*video*' },
];
assert(T.routeServer(serversBC, 'https://x.com/video.mp4').name === 'B', '同命中时按顺序取首个');
// 无 * 项时列表第一项兜底
const noDefault = [
  { name: 'X', url: 'http://x', token: '', pattern: '*zzz*' },
  { name: 'Y', url: 'http://y', token: '', pattern: '*qqq*' },
];
assert(T.routeServer(noDefault, 'https://a.com/f.zip').name === 'X', '无默认服务器时第一项兜底');
assert(T.defaultServer(noDefault).name === 'X', 'defaultServer 无 * 时取第一项');
assert(T.defaultServer(servers).name === 'A', 'defaultServer 取 pattern 为 * 的项');
// resolveServers 迁移兼容：servers 为空时用旧版字段构造默认项
const migrated = T.resolveServers({ serverUrl: 'http://127.0.0.1:16801', apiToken: 'tok', servers: [] });
assert(migrated.length === 1 && migrated[0].url === 'http://127.0.0.1:16801' && migrated[0].token === 'tok' && migrated[0].pattern === '*', 'servers 为空时迁移旧版单服务器字段');
const kept = T.resolveServers({ serverUrl: 'http://legacy', apiToken: '', servers });
assert(kept.length === 3 && kept[1].name === 'B', 'servers 非空时优先使用列表');

console.log('== 媒体嗅探匹配（sniffMatch）==');
assert(T.sniffMatch('https://a.com/v/master.m3u8', '', 'xmlhttprequest')?.ext === 'm3u8', 'm3u8 后缀命中');
assert(T.sniffMatch('https://a.com/v/seg1.ts?token=x', '', 'other')?.ext === 'ts', 'ts 后缀带参数命中');
assert(T.sniffMatch('https://a.com/v/play', 'application/vnd.apple.mpegurl', 'xmlhttprequest') !== null, 'Content-Type mpegurl 命中');
assert(T.sniffMatch('https://a.com/v/manifest', 'application/dash+xml', 'xmlhttprequest') !== null, 'Content-Type dash+xml 命中');
assert(T.sniffMatch('https://a.com/v/clip', 'video/mp4', 'other') !== null, 'Content-Type video/ 命中');
assert(T.sniffMatch('https://a.com/a/song', 'audio/mpeg', 'other') !== null, 'Content-Type audio/ 命中');
assert(T.sniffMatch('https://a.com/v/raw', '', 'media') !== null, 'media 资源类型兜底命中');
assert(T.sniffMatch('https://a.com/f.zip', 'application/zip', 'other') === null, 'zip 不命中');
assert(T.sniffMatch('https://a.com/doc.pdf', 'application/pdf', 'other') === null, 'pdf 不命中');
assert(T.sniffMatch('chrome-extension://abc/y.m3u8', '', 'other') === null, '非 http(s) URL 不命中');

console.log('== 外部请求 options 白名单（sanitizeExternalOptions）==');
const extOpts = T.sanitizeExternalOptions({ dir: '/dl', out: 'f.zip', split: 16, headers: ['X: y'], evil: 'rm -rf' });
assert(!('dir' in extOpts) && extOpts.out === 'f.zip' && extOpts.split === 16, '外部请求仅可设置安全文件名和白名单选项');
assert(!('headers' in extOpts) && !('evil' in extOpts), '非白名单键被丢弃');

// ==================== v3.1 新增 ====================
console.log('== 嗅探正则过滤（wildcardToRegex / matchSniffRegexRules）==');
const re1 = T.wildcardToRegex('*.example.com*m3u8*');
assert(re1.test('https://cdn.example.com/a/b.m3u8?x=1'), '通配符规则命中 m3u8 地址');
assert(!re1.test('https://other.com/a/b.m3u8'), '通配符规则拒绝其他域名');
assert(T.matchSniffRegexRules([], 'https://a.com/x.mp4'), '规则为空 = 全部进列表');
assert(T.matchSniffRegexRules(null, 'https://a.com/x.mp4'), '规则为 null = 全部进列表');
assert(T.matchSniffRegexRules([{ url: '*.a.com*', state: true }], 'https://dl.a.com/x.mp4'), '命中 state=true 规则进列表');
assert(!T.matchSniffRegexRules([{ url: '*.a.com*', state: true }], 'https://b.com/x.mp4'), '未命中规则不进列表');
assert(!T.matchSniffRegexRules([{ url: '*.a.com*', state: false }], 'https://a.com/x.mp4'), 'state=false 规则不生效');
assert(T.matchSniffRegexRules([{ url: '/^https:\/\/cdn\.a\.com\/.*\.mp4/', state: true }], 'https://cdn.a.com/v/x.mp4'), '/正则/ 形式规则命中');
assert(!T.matchSniffRegexRules([{ url: '[invalid(regex', state: true }], 'https://a.com/x.mp4'), '非法规则被跳过');

console.log('== 文件名模板（renderFileNameTemplate）==');
const tplData = { url: 'https://a.com/dir/My%20Movie.mp4', title: '页面/标题', now: new Date(2026, 9, 20).getTime() };
assert(T.renderFileNameTemplate('${title}.${ext}', tplData) === '页面_标题.mp4', 'title+ext 变量渲染（标题斜杠转下划线）');
assert(T.renderFileNameTemplate('${fileName}', tplData) === 'My Movie', 'fileName 变量（URL 解码+去扩展名）');
assert(T.renderFileNameTemplate('${host}', tplData) === 'a.com', 'host 变量');
assert(T.renderFileNameTemplate('${date}', tplData) === '20261020', 'date 变量 YYYYMMDD');
assert(T.renderFileNameTemplate('${host}/${date}/${fileName}.${ext}', tplData) === 'a.com/20261020/My Movie.mp4', '多变量组合');
assert(T.renderFileNameTemplate('${unknown}.x', tplData) === '${unknown}.x', '未知变量原样保留');
assert(T.renderFileNameTemplate('', tplData) === '', '空模板返回空串');
assert(T.renderFileNameTemplate('${fileName}.${ext}', { url: 'https://a.com/noext', now: 0 }) === 'noext.', '无扩展名文件 ext 为空');

console.log('== 自动下载判定（shouldAutoDownload）==');
const adCfg = { autoDownloadSniffed: true, autoDownloadMinSizeMB: 10 };
const bigMp4 = { url: 'https://a.com/big.mp4', size: 20 * 1048576, type: 'MP4' };
const smallMp4 = { url: 'https://a.com/small.mp4', size: 5 * 1048576, type: 'MP4' };
const liveM3u8 = { url: 'https://a.com/live.m3u8', size: 0, type: 'HLS' };
assert(T.shouldAutoDownload(bigMp4, adCfg, new Set()), '体积达标自动下载');
assert(!T.shouldAutoDownload(bigMp4, { ...adCfg, autoDownloadSniffed: false }, new Set()), '开关关闭不自动下载');
assert(!T.shouldAutoDownload(smallMp4, adCfg, new Set()), '体积不足不自动下载');
assert(!T.shouldAutoDownload(liveM3u8, adCfg, new Set()), 'm3u8 直播流（体积未知）不自动下载');
assert(!T.shouldAutoDownload(bigMp4, adCfg, new Set([bigMp4.url])), '同一 URL 只自动发一次');
assert(!T.shouldAutoDownload({ url: 'blob:https://a.com/x', size: 99 * 1048576, type: 'MP4' }, adCfg, new Set()), '非 http(s) 地址不自动下载');

console.log('== 深度搜索（addDeepSearchMedia / scanDeepSearch）==');
const added = T.addDeepSearchMedia(991, ['https://a.com/v/master.m3u8', 'https://a.com/v/clip.mp4', 'not-a-url', 'magnet:?xt=1'], 'https://a.com/page');
assert(added === 2, '深度搜索结果过滤后入列表（2 条有效）');
assert(T.addDeepSearchMedia(991, ['https://a.com/v/master.m3u8'], 'https://a.com/page') === 0, '重复 URL 不再入列表');
const dsEntry = T.sniffedMedia.get(991)?.get('https://a.com/v/master.m3u8');
assert(dsEntry?.source === 'deepSearch' && dsEntry?.type === 'HLS', '深度搜索条目标记 source=deepSearch');
assert(dsEntry?.headers?.referer === 'https://a.com/page', '深度搜索条目携带页面 referer');
sandbox.document = { scripts: [{ textContent: 'const video = "https://a.com/from-script.mp4";' }] };
sandbox.window = { __INITIAL_STATE__: { video: 'https://a.com/from-state.mp4' } };
sandbox.location = { href: 'https://a.com/page', protocol: 'https:' };
const scan = T.scanDeepSearch();
assert(scan.urls.includes('https://a.com/from-script.mp4') && scan.urls.includes('https://a.com/from-state.mp4'), '扫描直接返回内联脚本与播放器全局变量中的媒体');
assert(scan.href === 'https://a.com/page', '扫描返回来源页面');

console.log('== 自动下载集成（maybeAutoDownload 防重复）==');
await chrome.storage.local.set({ autoDownloadSniffed: true, autoDownloadMinSizeMB: 1 });
const adMedia = { url: 'https://a.com/auto.mp4', size: 5 * 1048576, type: 'MP4', filename: 'auto.mp4', headers: {} };
await T.maybeAutoDownload(adMedia);
assert(!T.autoSentSet.has(adMedia.url), '自动下载失败释放防重标记，允许重试');
fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'auto-1' }) });
await T.maybeAutoDownload(adMedia);
assert(T.autoSentSet.has(adMedia.url), '自动下载成功 URL 记入防重集合');
const sentBefore = calls.fetch.length;
await T.maybeAutoDownload(adMedia);
assert(calls.fetch.length === sentBefore, '同一 URL 重复触发不重复发送');
fetchImpl = null;
await T.maybeAutoDownload({ url: 'https://a.com/tiny.mp4', size: 100, type: 'MP4', filename: 'tiny.mp4', headers: {} });
assert(!T.autoSentSet.has('https://a.com/tiny.mp4'), '体积不足的媒体不进入防重集合');
await chrome.storage.local.set({ autoDownloadSniffed: false, autoDownloadMinSizeMB: 10 });

// ==================== v3.2 新增 ====================
console.log('== 下载前确认：pendingConfirm 生命周期 ==');
const tok1 = await T.addPendingConfirm({ url: 'https://a.com/f.zip', referer: 'https://a.com/', filename: 'f.zip', headers: ['Cookie: x=1'], itemId: 123 });
assert(typeof tok1 === 'string' && tok1.length >= 8, 'addPendingConfirm 返回随机 token');
const pe1 = await T.getPendingConfirm(tok1);
assert(pe1?.url === 'https://a.com/f.zip' && pe1?.itemId === 123 && pe1?.headers?.[0] === 'Cookie: x=1', 'getPendingConfirm 从内存 Map 取回完整任务');
T.pendingConfirms.delete(tok1); // 模拟 SW 重启内存丢失
const pe2 = await T.getPendingConfirm(tok1);
assert(pe2?.filename === 'f.zip' && pe2?.referer === 'https://a.com/', 'SW 重启后从 storage.session 兜底恢复');
await T.removePendingConfirm(tok1);
assert((await T.getPendingConfirm(tok1)) === null, 'removePendingConfirm 后内存与 session 均清除');
assert((await T.getPendingConfirm('nonexistent-token')) === null, '未知 token 返回 null');
assert((await T.getPendingConfirm('')) === null, '空 token 返回 null');

console.log('== 下载前确认：服务器路由预选（resolveConfirmServers）==');
const rc1 = T.resolveConfirmServers({ servers }, 'https://pan.baidu.com/s/x.zip', 'x.zip');
assert(rc1.servers.length === 3 && rc1.matchedIndex === 1, '按路由命中预选对应服务器');
const rc2 = T.resolveConfirmServers({ servers }, 'https://other.com/y.zip', 'y.zip');
assert(rc2.matchedIndex === 0, '未命中时预选默认服务器（pattern *）');

console.log('== 下载前确认：接管流程挂起 + 确认/取消 ==');
await chrome.storage.local.set({ askBeforeDownload: true, enabled: true, servers });
const fetchBefore = calls.fetch.length;
listeners.onDeterminingFilename(item({ id: 555, url: 'https://a.com/big.zip', finalUrl: 'https://a.com/big.zip', filename: 'big.zip', referrer: 'https://a.com/page' }));
assert(await until(() => calls.windowsCreate.length === 1), '开启 askBeforeDownload 后弹确认窗口（windows.create）');
const winProps = calls.windowsCreate[0] || {};
assert(winProps.type === 'popup' && winProps.width === 360, '确认窗口为 360px 弹窗');
assert(typeof winProps.url === 'string' && winProps.url.includes('mode=confirm') && /[?&]token=[0-9a-z]+/.test(winProps.url), '确认窗口 URL 携带 mode 与 token');
assert(calls.fetch.length === fetchBefore, '确认前不直接发送任务');
assert(calls.downloadsCancel.length === 0, '确认前不取消浏览器下载（保持挂起）');
// 确认 → POST 任务（改名+分片+指定服务器）→ cancel 浏览器下载 → 清除待确认
fetchImpl = async () => ({ ok: true, json: async () => ({ gid: 'g1' }) });
const confirmToken = new URL(winProps.url).searchParams.get('token');
const cResp = await new Promise(res => listeners.onMessage({ type: 'confirmDownload', token: confirmToken, filename: 'renamed.zip', split: 8, serverIndex: 1 }, {}, res));
assert(cResp?.ok === true, 'confirmDownload 返回 ok');
const postArgs = calls.fetch[calls.fetch.length - 1];
assert(String(postArgs[0]).startsWith('http://b:6800/'), '确认下载按 serverIndex 选择目标服务器');
const postBody = JSON.parse(postArgs[1].body);
assert(postBody.url === 'https://a.com/big.zip' && postBody.options.out === 'renamed.zip' && postBody.options.split === 8, 'POST 任务携带修改后的文件名与分片数');
assert(calls.downloadsCancel.includes(555), '确认后取消浏览器下载');
assert((await T.getPendingConfirm(confirmToken)) === null, '确认后待确认任务已清除');
// 取消 → resume 恢复浏览器下载 → 清除待确认
const tok2 = await T.addPendingConfirm({ url: 'https://a.com/q.zip', referer: '', filename: 'q.zip', headers: [], itemId: 777 });
const xResp = await new Promise(res => listeners.onMessage({ type: 'cancelPendingDownload', token: tok2 }, {}, res));
assert(xResp?.ok === true && calls.downloadsResume.includes(777), '取消后恢复浏览器下载');
assert((await T.getPendingConfirm(tok2)) === null, '取消后待确认任务已清除');
// 过期/未知任务查询返回错误
const eResp = await new Promise(res => listeners.onMessage({ type: 'getPendingConfirm', token: 'nope' }, {}, res));
assert(eResp?.error === 'expired', '过期任务查询返回 expired 错误');
fetchImpl = null;
await chrome.storage.local.set({ askBeforeDownload: false });

console.log('== 管理面板多形态（panelOpenStyle）==');
assert(T.normalizePanelStyle('window') === 'window' && T.normalizePanelStyle('bogus') === 'popup' && T.normalizePanelStyle('') === 'popup', '非法面板形态回退 popup');
await T.applyPanelStyle('popup');
assert(calls.setPopup.at(-1)?.popup === 'popup.html', 'popup 形态保留 default_popup');
await T.applyPanelStyle('newtab');
assert(calls.setPopup.at(-1)?.popup === '', 'newtab 形态运行时清空 action popup');
await T.applyPanelStyle('sidepanel');
assert(calls.setPopup.at(-1)?.popup === '' && calls.sidePanelOptions.at(-1)?.path === 'popup.html', 'sidepanel 形态清空 popup 并设置侧边栏路径');
await T.openPanel('newtab', { windowId: 7 });
assert(calls.tabsCreate.at(-1)?.url === 'http://a:6800', 'newtab 形态新标签页打开默认服务器地址');
await T.openPanel('window', { windowId: 7 });
const wp = calls.windowsCreate.at(-1);
assert(wp?.type === 'popup' && wp?.width === 1100 && wp?.height === 720 && wp?.url === 'http://a:6800', 'window 形态 1100x720 独立窗口');
await T.openPanel('sidepanel', { windowId: 7 });
assert(calls.sidePanelOpen.at(-1)?.windowId === 7, 'sidepanel 形态调用 sidePanel.open');
assert(typeof listeners.actionOnClicked === 'function', 'action.onClicked 已注册（非 popup 形态点击分发入口）');
await chrome.storage.local.set({ panelOpenStyle: 'sidepanel' });
listeners.actionOnClicked({ windowId: 9 });
assert(await until(() => calls.sidePanelOpen.at(-1)?.windowId === 9), '点击图标按配置形态分发（sidepanel）');
await chrome.storage.local.set({ panelOpenStyle: 'popup' });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
