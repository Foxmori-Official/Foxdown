// i18n 手动切换覆盖层测试：mock chrome（storage.sync / runtime.getURL / i18n.getMessage /
// i18n.getUILanguage），fetch 映射到本地 extension/_locales/<目录>/messages.json，
// vm 加载 extension/i18n.js。
// 断言：非 auto 返回覆盖语言消息、$1..$N 占位替换、auto 按浏览器 UI 语言解析
// （地区映射 zh-HK→zh_TW / pt-PT→pt_BR；不支持语言回退 Chrome 原生 → default en）、
// 未知 key 回退 key 本身。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const code = fs.readFileSync(path.join(EXT, 'i18n.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// locale: storage.sync.get({locale:'auto'}) 返回的 locale 值（undefined = 未设置过）
// uiLang: mock 的浏览器 UI 语言（chrome.i18n.getUILanguage 返回值，默认 ru = 不支持）
function makeCtx(locale, uiLang = 'ru') {
  const storageData = {};
  if (locale !== undefined) storageData.locale = locale;
  const chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...storageData }),
        set: async (obj) => Object.assign(storageData, obj),
      },
    },
    runtime: { getURL: (p) => p }, // 直接映射为 extension 下相对路径
    i18n: {
      getMessage: (k) => (k === 'menuLink' || k === 'stateFailed' ? 'GM:' + k : ''),
      getUILanguage: () => uiLang,
    },
  };
  const sandbox = {
    chrome, console,
    fetch: async (url) => {
      try {
        const text = fs.readFileSync(path.join(EXT, String(url)), 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      } catch {
        return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
      }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const msg = (dir, key) => JSON.parse(fs.readFileSync(path.join(EXT, '_locales', dir, 'messages.json'), 'utf8'))[key].message;

console.log('== 非 auto：加载德语覆盖层 ==');
const de = makeCtx('de');
await de.loadI18nOverride();
assert(de.i18n('menuLink') === msg('de', 'menuLink'), 'de 覆盖：menuLink 返回德语消息（非浏览器 getMessage）');
assert(de.i18n('stateFailed', 'boom') === 'Verbindung fehlgeschlagen: boom', 'de 覆盖：$1 占位替换（展开参数）');
assert(de.i18n('testSuccess', ['ok', '2.0', 'engineX', 'yes']) === 'Verbunden: aria2=ok (2.0), Streaming-Engine=engineX, ffmpeg=yes', 'de 覆盖：$1..$4 占位替换（数组参数）');
assert(de.i18n('batchResult', ['3', '']) === '3 erfolgreich', 'de 覆盖：$2 为空串时替换为空');
assert(de.i18n('batchResult', '3', ', 1 fehlgeschlagen') === '3 erfolgreich, 1 fehlgeschlagen', 'de 覆盖：两个展开参数替换 $1/$2');
assert(de.i18n('no_such_key_xyz') === 'no_such_key_xyz', '覆盖层缺失且 getMessage 为空 → 回退 key 本身');

console.log('== 目录映射：pt-BR / zh-TW ==');
const pt = makeCtx('pt-BR');
await pt.loadI18nOverride();
assert(pt.i18n('menuLink') === msg('pt_BR', 'menuLink'), 'pt-BR → pt_BR 目录映射');
const tw = makeCtx('zh-TW');
await tw.loadI18nOverride();
assert(tw.i18n('menuLink') === msg('zh_TW', 'menuLink'), 'zh-TW → zh_TW 目录映射');

console.log('== auto：按浏览器 UI 语言解析（Chrome 原生不做地区映射，覆盖层补齐） ==');
const autoZhHk = makeCtx('auto', 'zh-HK');
await autoZhHk.loadI18nOverride();
assert(autoZhHk.i18n('menuLink') === msg('zh_TW', 'menuLink'), 'auto + UI=zh-HK → zh_TW（繁中地区映射）');
const autoZhCn = makeCtx('auto', 'zh-CN');
await autoZhCn.loadI18nOverride();
assert(autoZhCn.i18n('menuLink') === msg('zh_CN', 'menuLink'), 'auto + UI=zh-CN → zh_CN（精确匹配）');
const autoPtPt = makeCtx('auto', 'pt-PT');
await autoPtPt.loadI18nOverride();
assert(autoPtPt.i18n('menuLink') === msg('pt_BR', 'menuLink'), 'auto + UI=pt-PT → pt_BR（葡语地区映射）');
const autoDeAt = makeCtx('auto', 'de-AT');
await autoDeAt.loadI18nOverride();
assert(autoDeAt.i18n('menuLink') === msg('de', 'menuLink'), 'auto + UI=de-AT → de（前缀匹配）');
const autoEnUs = makeCtx('auto', 'en-US');
await autoEnUs.loadI18nOverride();
assert(autoEnUs.i18n('menuLink') === msg('en', 'menuLink'), 'auto + UI=en-US → en（前缀匹配）');

console.log('== auto / 未设置 / 未知值 + 不支持语言：回退 Chrome 原生（default_locale: en） ==');
const auto = makeCtx('auto', 'ru');
await auto.loadI18nOverride();
assert(auto.i18n('menuLink') === 'GM:menuLink', 'auto + UI=ru（不支持）→ 回退 chrome.i18n 原生');
assert(auto.i18n('no_such_key_xyz') === 'no_such_key_xyz', 'auto + 未知 key → 回退 key 本身');
const unset = makeCtx(undefined, 'ru');
await unset.loadI18nOverride();
assert(unset.i18n('menuLink') === 'GM:menuLink', 'storage 无 locale 键（默认 auto）+ UI=ru → 回退 getMessage');
const bogus = makeCtx('xx-UNKNOWN', 'ru');
await bogus.loadI18nOverride();
assert(bogus.i18n('menuLink') === 'GM:menuLink', '未知 locale 值 → 回退 getMessage');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
