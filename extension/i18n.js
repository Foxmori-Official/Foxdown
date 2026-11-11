// Foxdown Connector - 手动语言切换覆盖层
// Chrome 原生 chrome.i18n 只能跟随浏览器语言、无法运行时切换；
// 本文件从 chrome.storage.sync 读取 { locale }（'auto' = 跟随系统），
// 非 auto 时 fetch 对应 _locales/<目录>/messages.json 作为 OVERRIDE，
// i18n() 优先取 OVERRIDE，其次 chrome.i18n.getMessage，最后回退 key 本身。
// auto 时先用 resolveUiLocale 做地区/前缀解析（Chrome 原生只做"精确目录→default"，
// 不会把 zh-HK 落到 zh_TW）；解析不到的语言交还 Chrome 原生 → default_locale: en 兜底。
// 普通脚本：background.js 用 importScripts 加载，popup/options 用 <script> 加载，
// 两个全局函数挂到 globalThis，各上下文共用。
(function () {
  'use strict';
  // 选项值 → _locales 目录名（pt-BR→pt_BR、zh-CN→zh_CN、zh-TW→zh_TW，其余同名）
  const LOCALE_DIRS = {
    en: 'en', de: 'de', es: 'es', fr: 'fr', 'pt-BR': 'pt_BR',
    ja: 'ja', 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW', ko: 'ko'
  };
  let activeLocale = 'en';
  let loadGeneration = 0;
  let OVERRIDE = null; // Chrome messages.json 格式：{ key: { message: '...' } } | null

  // 浏览器 UI 语言 → 支持语言（与 Web 端 resolveLocale 同规则）。
  // 返回 null 表示不支持（如 ru）：不加载覆盖层，走 Chrome 原生 → default_locale: en。
  function resolveUiLocale(uiLang) {
    const lang = String(uiLang || '').toLowerCase();
    if (!lang) return null;
    const keys = Object.keys(LOCALE_DIRS);
    const exact = keys.find((k) => k.toLowerCase() === lang);
    if (exact) return exact;
    const prefix = lang.split('-')[0];
    if (prefix === 'zh') return /tw|hk|mo|hant/.test(lang) ? 'zh-TW' : 'zh-CN';
    if (prefix === 'pt') return 'pt-BR';
    return keys.find((k) => k.toLowerCase().split('-')[0] === prefix) || null;
  }

  // 从 chrome.storage.sync 读取语言设置并（必要时）载入覆盖消息表
  async function loadI18nOverride() {
    const generation = ++loadGeneration;
    OVERRIDE = null;
    activeLocale = resolveUiLocale(chrome.i18n.getUILanguage?.()) || 'en';
    try {
      const s = await chrome.storage.sync.get({ locale: 'auto' });
      let pref = s && s.locale;
      if (!pref || pref === 'auto') {
        pref = resolveUiLocale(chrome.i18n.getUILanguage && chrome.i18n.getUILanguage());
      }
      const dir = LOCALE_DIRS[pref];
      if (!dir) return; // 未知值或解析不到：跟随 Chrome 原生（default_locale: en）
      const res = await fetch(chrome.runtime.getURL('_locales/' + dir + '/messages.json'));
      if (!res || !res.ok) return;
      const data = await res.json();
      if (generation === loadGeneration && data && typeof data === 'object') {
        OVERRIDE = data;
        activeLocale = pref;
      }
    } catch (e) {
      if (generation === loadGeneration) OVERRIDE = null;
    }
  }

  // i18n(key, ...subs)：subs 兼容两种用法——展开参数 i18n('k', 'a', 'b')
  // 或单个数组 i18n('k', ['a', 'b'])（与 chrome.i18n.getMessage 一致）；$1..$N 占位替换
  function i18n(key, ...subs) {
    const flat = subs.length === 1 && Array.isArray(subs[0]) ? subs[0] : subs;
    try {
      const entry = OVERRIDE && OVERRIDE[key];
      if (entry && typeof entry.message === 'string') {
        let msg = entry.message;
        for (let i = 0; i < flat.length; i++) {
          msg = msg.split('$' + (i + 1)).join(String(flat[i]));
        }
        return msg;
      }
    } catch (e) {}
    try {
      const sub = subs.length === 0 ? undefined : (subs.length === 1 ? subs[0] : flat);
      const msg = chrome.i18n.getMessage(key, sub);
      if (msg) return msg;
    } catch (e) {}
    return key;
  }

  globalThis.getI18nLocale = () => activeLocale;
  globalThis.i18n = i18n;
  globalThis.loadI18nOverride = loadI18nOverride;
})();
