// Foxdown Connector - 内容脚本
// 1) 批量下载时收集页面链接  2) 磁力链接点击拦截（捕获阶段，穿透 Shadow DOM）  3) Alt 点击旁路检测

// 配置缓存：只有开启接管且开启磁力捕获时才 preventDefault，否则不干扰页面行为
let cfgCache = { enabled: false, captureMagnet: false };
chrome.runtime.sendMessage({ type: 'getCapturePreferences' }).then(settings => {
  if (settings) cfgCache = { ...settings, ...preferenceChanges };
}).catch(() => {});
const preferenceChanges = {};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) preferenceChanges.enabled = changes.enabled.newValue;
  if (changes.captureMagnet) preferenceChanges.captureMagnet = changes.captureMagnet.newValue;
  if (changes.enabled) cfgCache.enabled = changes.enabled.newValue;
  if (changes.captureMagnet) cfgCache.captureMagnet = changes.captureMagnet.newValue;
});

// ---- 收集页面链接（供 background 批量下载） ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'kimi-collect-links') {
    const urls = [];
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL(a.getAttribute('href'), document.baseURI);
        const fileExtension = url.pathname.match(/\.([a-z0-9]{1,10})$/i)?.[1];
        if (url.protocol === 'magnet:' || a.hasAttribute('download') ||
            (fileExtension && !/^(?:html?|shtml|php|aspx?|jsp|cgi)$/i.test(fileExtension))) {
          urls.push(url.href);
        }
      } catch {}
    }
    for (const m of document.querySelectorAll('video[src], audio[src], video source[src], audio source[src]')) {
      try { urls.push(new URL(m.getAttribute('src'), document.baseURI).href); } catch {}
    }
    sendResponse(urls);
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
