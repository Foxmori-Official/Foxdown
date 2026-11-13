import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../extension/', import.meta.url);
const source = fs.readFileSync(new URL('i18n.js', root), 'utf8');
const messages = directory => JSON.parse(fs.readFileSync(new URL(`_locales/${directory}/messages.json`, root), 'utf8'));
const chinese = messages('zh_CN');
const english = messages('en');
let checked = 0;

for (const [preference, browser, expected] of [
  ['zh-CN', 'en-US', 'zh-CN'], ['en', 'zh-CN', 'en'],
  ['auto', 'zh-HK', 'zh-CN'], ['auto', 'zh-TW', 'zh-CN'], ['auto', 'zh-Hant', 'zh-CN'],
  ['auto', 'en-GB', 'en'],
  ['auto', 'de-AT', 'en'], ['de', 'zh-CN', 'en'], ['ja', 'en', 'en'],
  ['auto', 'pt-PT', 'en'], ['auto', 'ru', 'en'], [undefined, 'ru', 'en'],
  ['unsupported', 'zh-CN', 'en'],
]) {
  const context = vm.createContext({
    readSettings: async () => ({ locale: preference }),
    chrome: { i18n: { getUILanguage: () => browser, getMessage: () => '' }, runtime: { getURL: file => file } },
    fetch: async file => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8')) }),
  });
  vm.runInContext(source, context);
  await context.loadI18nOverride();
  const expectedMessages = expected === 'zh-CN' ? chinese : english;
  assert.equal(context.getI18nLocale(), expected);
  assert.equal(context.i18n('menuLink'), expectedMessages.menuLink.message);
  assert.equal(context.i18n('batchResult', '3', ''), expectedMessages.batchResult.message.replaceAll('$1', '3').replaceAll('$2', ''));
  assert.equal(context.i18n('testSuccess', ['ok', '2.0', 'engineX', 'yes']), expectedMessages.testSuccess.message
    .replaceAll('$1', 'ok').replaceAll('$2', '2.0').replaceAll('$3', 'engineX').replaceAll('$4', 'yes'));
  assert.equal(context.i18n('missing_test_key'), 'missing_test_key');
  checked++;
}
console.log(`Extension language switching passed for ${checked} supported and automatic preferences.`);
