// Foxdown Connector - 共享纯函数库 v3.1
// 被 background.js（importScripts）与测试共同使用。
// 本文件不依赖 chrome.* API，全部为可单测的纯函数。

// ============================================================
// 通配符 → 正则（参考 cat-catch js/init.js wildcardToRegex）
// * 匹配任意字符，? 匹配单个字符，其余正则特殊字符转义；忽略大小写、整串匹配
// ============================================================
function wildcardToRegex(urlPattern) {
  const regexPattern = String(urlPattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`, 'i');
}

// 规则字符串 → RegExp：/pattern/flags 形式按原生正则解析，否则按通配符转换
function sniffRuleToRegex(rule) {
  const s = String(rule || '').trim();
  if (!s) return null;
  if (s.length > 2 && s.startsWith('/')) {
    const lastSlash = s.lastIndexOf('/');
    if (lastSlash > 0) {
      try { return new RegExp(s.slice(1, lastSlash), s.slice(lastSlash + 1) || 'i'); } catch { return null; }
    }
  }
  try { return wildcardToRegex(s); } catch { return null; }
}

// ============================================================
// 嗅探正则过滤（参考 cat-catch init.js Regex 结构 [{url, state}]）
// rules 为空数组 = 全部放行；否则仅命中 state=true 规则的 URL 进入嗅探列表
// ============================================================
function matchSniffRegexRules(rules, url) {
  if (!Array.isArray(rules) || !rules.length) return true;
  if (!url) return false;
  for (const r of rules) {
    if (!r || r.state === false || !r.url) continue;
    const re = sniffRuleToRegex(r.url);
    if (re && re.test(url)) return true;
  }
  return false;
}

// ============================================================
// 文件名模板渲染（参考 cat-catch js/templates.js 变量体系，精简版）
// 支持变量：${title} 页面标题、${fileName} 原文件名（不含扩展名）、
//           ${ext} 扩展名、${host} 站点域名、${date} YYYYMMDD
// 未知变量原样保留；data.now 可注入固定时间便于测试
// ============================================================
function renderFileNameTemplate(template, data) {
  if (!template || typeof template !== 'string') return '';
  const d = data || {};
  let fullFileName = '';
  try { fullFileName = decodeURIComponent(new URL(d.url).pathname.split('/').pop() || ''); }
  catch { try { fullFileName = new URL(d.url).pathname.split('/').pop() || ''; } catch { fullFileName = ''; } }
  let fileName = fullFileName.split('.');
  if (fileName.length > 1) fileName.pop();
  fileName = fileName.join('.');
  let ext = d.ext || '';
  if (!ext) {
    const parts = fullFileName.split('.');
    ext = parts.length <= 1 ? '' : parts[parts.length - 1];
  }
  let host = d.host || '';
  if (!host) { try { host = new URL(d.url).hostname; } catch { host = ''; } }
  const now = d.now != null ? new Date(d.now) : new Date();
  const p2 = n => String(n).padStart(2, '0');
  const title = String(d.title ?? '').replace(/[/\\]/g, '_');
  const vars = {
    title,
    filename: fileName,
    savename: fileName || title,
    ext,
    host,
    date: `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`
  };
  return template.replace(/\$?\{(\w+)\}|<(\w+)>/g, (match, brace, angle) => {
    const key = (brace || angle).toLowerCase();
    return Object.hasOwn(vars, key) ? vars[key] : match;
  });
}

// ============================================================
// 自动下载判定（嗅探媒体）
// 开启 autoDownloadSniffed 后：体积 ≥ autoDownloadMinSizeMB 才自动发送；
// m3u8/mpd 播放列表无法确认体积时视为直播流，不自动下载；同一 URL 只发一次
// ============================================================
function shouldAutoDownload(media, cfg, sentSet) {
  if (!cfg || !cfg.autoDownloadSniffed) return false;
  if (!media || !media.url || !/^https?:/i.test(media.url)) return false;
  const minMB = Number(cfg.autoDownloadMinSizeMB) || 0;
  const size = Number(media.size) || 0;
  const isPlaylist = media.type === 'HLS' || media.type === 'DASH'
    || /\.(m3u8|mpd)(\?|#|$)/i.test(media.url);
  if (isPlaylist && size <= 0) return false; // m3u8 直播流（体积未知）跳过
  if (size < minMB * 1048576) return false;
  if (sentSet && sentSet.has(media.url)) return false; // 防重复
  return true;
}

// ============================================================
// 深度搜索：这个函数由 chrome.scripting 在页面主上下文运行。
// 保持函数独立，Chrome 将返回值直接交给扩展。
// ============================================================
function scanDeepSearch() {
  try {
    var MEDIA_RE = /["']((?:https?:)?\/\/[^"'\s<>]+?\.(?:m3u8|mpd|mp4|m4v|m4a|mp3|flv|ts|aac|ogg|webm|mkv|mov|wav|flac)(?:\?[^"'\s<>]*)?)["']/gi;
    var found = new Set();
    var remaining = 4000;
    function add(u) {
      if (!u) return;
      u = u.replace(/\\/g, '').trim();
      if (u.indexOf('//') === 0) u = location.protocol + u;
      if (!/^https?:\/\//i.test(u)) return;
      found.add(u);
    }
    function scanText(text) {
      if (!text) return;
      var m; MEDIA_RE.lastIndex = 0;
      while (found.size < 200 && (m = MEDIA_RE.exec(text)) !== null) add(m[1] || m[0]);
    }
    // 1) 扫描内联脚本文本（cat-catch search.js 同款做法）
    var scripts = document.scripts || [];
    for (var i = 0; i < scripts.length && found.size < 200 && i < 400; i++) {
      if (!scripts[i].src && scripts[i].textContent) scanText(scripts[i].textContent);
    }
    // 2) 扫描常见播放器/框架全局变量（深度受限遍历，字符串值过 URL 正则）
    var GLOBALS = ['__INITIAL_STATE__', '__APOLLO_STATE__', '__NEXT_DATA__', '__NUXT__', '__NUXT_DATA__',
      '__playinfo__', '__PLAYINFO__', 'playerConfig', 'PLAYER_CONFIG', '__PLAYER_CONFIG__',
      'playInfo', 'videoInfo', '__VIDEO_INFO__', 'flashvars', '__INITIAL_DATA__'];
    function walk(obj, depth) {
      if (!obj || depth > 6) return;
      if (typeof obj === 'string') {
        if (/^(?:https?:)?\/\//i.test(obj) && /\.(?:m3u8|mpd|mp4|m4v|m4a|mp3|flv|ts|aac|ogg|webm|mkv|mov|wav|flac)(?:[?#]|$)/i.test(obj)) add(obj);
        else scanText(obj);
        return;
      }
      if (typeof obj !== 'object') return;
      for (var k in obj) {
        if (--remaining < 0 || found.size >= 200) break;
        try { walk(obj[k], depth + 1); } catch (e) {}
      }
    }
    for (var g = 0; g < GLOBALS.length; g++) {
      try { if (window[GLOBALS[g]]) walk(window[GLOBALS[g]], 0); } catch (e) {}
    }
    return { urls: Array.from(found), href: location.href };
  } catch (e) {
    return { urls: [], href: location.href };
  }
}
