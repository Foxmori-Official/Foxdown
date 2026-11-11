import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { waitFor } from '../helpers/extension-background.mjs';

test('late locale responses cannot overwrite newer language or metadata', async () => {
  const source = fs.readFileSync(new URL('../../extension/i18n.js', import.meta.url), 'utf8');
  let locale = 'de';
  const pending = new Map();
  const context = vm.createContext({ chrome: {
    storage: { sync: { get: async () => ({ locale }) } },
    i18n: { getUILanguage: () => 'en', getMessage: () => 'native-English' },
    runtime: { getURL: file => file },
  }, fetch: url => new Promise(resolve => pending.set(url, resolve)) });
  vm.runInContext(source, context);
  const german = context.loadI18nOverride();
  await waitFor(() => pending.has('_locales/de/messages.json'));
  locale = 'ja';
  const japanese = context.loadI18nOverride();
  await waitFor(() => pending.has('_locales/ja/messages.json'));
  pending.get('_locales/ja/messages.json')({ ok: true, json: async () => ({ test: { message: 'Japanese' } }) });
  await japanese;
  pending.get('_locales/de/messages.json')({ ok: true, json: async () => ({ test: { message: 'German' } }) });
  await german;
  assert.equal(context.i18n('test'), 'Japanese');
  assert.equal(context.getI18nLocale(), 'ja');
  locale = 'unsupported';
  await context.loadI18nOverride();
  assert.equal(context.getI18nLocale(), 'en');
  assert.equal(context.i18n('test'), 'native-English');
});
