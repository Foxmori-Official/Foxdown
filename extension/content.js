// Foxdown Connector - 内容脚本
// 1) 批量下载时收集页面链接  2) 磁力链接点击拦截（捕获阶段，穿透 Shadow DOM）  3) Alt 点击旁路检测
// 4) v3.1 深度搜索（cat-catch 方案）：<script> 文本节点注入页面主上下文，
//    扫描内联脚本与常见播放器全局变量中的媒体 URL，经 postMessage 回传中继给 background

// 配置缓存：只有开启接管且开启磁力捕获时才 preventDefault，否则不干扰页面行为
let cfgCache = { enabled: true, captureMagnet: true };
chrome.storage.sync.get({ enabled: true, captureMagnet: true }).then(s => { cfgCache = s; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) cfgCache.enabled = changes.enabled.newValue;
  if (changes.captureMagnet) cfgCache.captureMagnet = changes.captureMagnet.newValue;
});

// ---- 深度搜索：注入页面主上下文执行扫描（lib.js 提供 deepSearchScanSource） ----
let deepSearchLastRun = 0;
function runDeepSearch() {
  // 简单节流：2 秒内重复触发只执行一次
  const now = Date.now();
  if (now - deepSearchLastRun < 2000) return;
  deepSearchLastRun = now;
  try {
    const script = document.createElement('script');
    script.textContent = '(' + deepSearchScanSource + ')()';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) { /* 页面 CSP 拒绝内联注入时放弃 */ }
}

// 主上下文扫描结果 → background（标记 source: 'deepSearch' 由 background 添加）
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.type !== 'kimi-deep-search-result' || !Array.isArray(d.urls)) return;
  if (!d.urls.length) return;
  chrome.runtime.sendMessage({
    type: 'kimi-deep-search-media',
    urls: d.urls,
    href: location.href
  }).catch(() => {});
});

// ---- 收集页面链接（供 background 批量下载） ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'kimi-collect-links') {
    const urls = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try { urls.push(new URL(a.getAttribute('href'), location.href).href); } catch {}
    }
    for (const m of document.querySelectorAll('img[src], video[src], audio[src], source[src]')) {
      try { urls.push(new URL(m.getAttribute('src'), location.href).href); } catch {}
    }
    sendResponse(urls);
    return true;
  }
  // background 触发深度搜索（popup 按钮 或 页面加载完成自动执行）
  if (msg?.type === 'kimi-deep-search') {
    runDeepSearch();
    sendResponse({ ok: true });
    return true;
  }
});

// ---- 磁力链接拦截 + Alt 旁路（Aria2-Explorer 方案：捕获阶段 + composedPath） ----
function getMagnetUrl(event) {
  const path = event.composedPath?.() || [];
  for (const el of path) {
    if (el.nodeType !== Node.ELEMENT_NODE) continue;
    const href = el.getAttribute?.('href');
    if (href && /^magnet:/i.test(href.trim())) return href.trim();
  }
  const a = event.target?.closest?.('a[href^="magnet:"], area[href^="magnet:"]');
  return a ? a.getAttribute('href').trim() : null;
}

document.addEventListener('click', (event) => {
  if (event.altKey) {
    chrome.runtime.sendMessage({ type: 'CLICK_EVENT', altKey: true }).catch(() => {});
  }
  if (!cfgCache.enabled || !cfgCache.captureMagnet || event.altKey) return;
  const magnetUrl = getMagnetUrl(event);
  if (magnetUrl) {
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'MAGNET_DOWNLOAD',
      url: magnetUrl,
      referer: location.href
    }).catch(() => {});
  }
}, true);
