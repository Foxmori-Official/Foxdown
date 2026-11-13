import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { waitFor } from '../helpers/extension-background.mjs';

test('late locale responses cannot overwrite newer language or metadata', async () => {
  const source = fs.readFileSync(new URL('../../extension/i18n.js', import.meta.url), 'utf8');
  let locale = 'en';
  const pending = new Map();
  const context = vm.createContext({ readSettings: async () => ({ locale }), chrome: {
    i18n: { getUILanguage: () => 'en', getMessage: () => 'native-English' },
    runtime: { getURL: file => file },
  }, fetch: url => new Promise(resolve => pending.set(url, resolve)) });
  vm.runInContext(source, context);
  const english = context.loadI18nOverride();
  await waitFor(() => pending.has('_locales/en/messages.json'));
  locale = 'zh-CN';
  const chinese = context.loadI18nOverride();
  await waitFor(() => pending.has('_locales/zh_CN/messages.json'));
  pending.get('_locales/zh_CN/messages.json')({ ok: true, json: async () => ({ test: { message: 'Chinese' } }) });
  await chinese;
  pending.get('_locales/en/messages.json')({ ok: true, json: async () => ({ test: { message: 'English' } }) });
  await english;
  assert.equal(context.i18n('test'), 'Chinese');
  assert.equal(context.getI18nLocale(), 'zh-CN');
  locale = 'unsupported';
  const fallback = context.loadI18nOverride();
  await new Promise(resolve => setImmediate(resolve));
  pending.get('_locales/en/messages.json')({ ok: true, json: async () => ({ test: { message: 'English' } }) });
  await fallback;
  assert.equal(context.getI18nLocale(), 'en');
  assert.equal(context.i18n('test'), 'English');
});
