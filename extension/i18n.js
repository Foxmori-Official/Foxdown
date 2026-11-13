// Runtime language override for the two supported UI languages.
(function () {
  'use strict';
  const LOCALE_DIRS = { en: 'en', 'zh-CN': 'zh_CN' };
  let activeLocale = 'en';
  let loadGeneration = 0;
  let OVERRIDE = null; // Chrome messages.json 格式：{ key: { message: '...' } } | null

  function resolveUiLocale(language) {
    return /^zh(?:[-_]|$)/i.test(String(language || '')) ? 'zh-CN' : 'en';
  }

  // 从 chrome.storage.local 读取语言设置并（必要时）载入覆盖消息表
  async function loadI18nOverride() {
    const generation = ++loadGeneration;
    OVERRIDE = null;
    activeLocale = resolveUiLocale(chrome.i18n.getUILanguage?.()) || 'en';
    try {
      const s = await readSettings({ locale: 'auto' });
      let pref = s && s.locale;
      if (!pref || pref === 'auto') {
        pref = resolveUiLocale(chrome.i18n.getUILanguage && chrome.i18n.getUILanguage());
      }
      if (!Object.hasOwn(LOCALE_DIRS, pref)) pref = 'en';
      const dir = LOCALE_DIRS[pref];
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
