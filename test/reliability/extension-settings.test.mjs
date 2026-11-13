import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../extension/settings.js', import.meta.url), 'utf8');

function storageFixture() {
  const sync = { apiToken: 'legacy-fixture-token', serverUrl: 'http://localhost:16801', enabled: false };
  const local = { onboardingCompleted: true };
  let queue = Promise.resolve();
  const locks = { request: (_name, callback) => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  } };
  const select = (data, keys) => {
    if (keys === null) return structuredClone(data);
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
    return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) };
  };
  const storage = {
    sync: {
      get: async keys => select(sync, keys),
      remove: async keys => { for (const key of keys) delete sync[key]; },
    },
    local: { get: async keys => select(local, keys), set: async patch => Object.assign(local, structuredClone(patch)) },
  };
  const context = () => {
    const sandbox = vm.createContext({ chrome: { storage }, navigator: { locks } });
    vm.runInContext(source + '\n;globalThis.testing = {readSettings, writeSettings};', sandbox);
    return sandbox.testing;
  };
  return { sync, local, storage, context };
}

test('legacy sync settings migrate to local before reads and a long rule list can be saved', async () => {
  const b = storageFixture();
  const settings = b.context();
  assert.equal((await settings.readSettings({ apiToken: '' })).apiToken, 'legacy-fixture-token');
  assert.equal(b.local.enabled, false);
  assert.equal(b.local.onboardingCompleted, true);
  assert.deepEqual(b.sync, {});
  const domainList = 'download.example.invalid\n'.repeat(1000);
  await settings.writeSettings({ domainList });
  assert.equal((await settings.readSettings({ domainList: '' })).domainList, domainList);
  assert.deepEqual(b.sync, {});
});

test('concurrent extension contexts preserve local credentials and subsequent edits', async () => {
  const b = storageFixture();
  b.local.apiToken = 'newer-fixture-token';
  const first = b.context();
  const second = b.context();
  await Promise.all([
    first.writeSettings({ serverUrl: 'http://localhost:18001' }),
    second.readSettings({ serverUrl: '' }),
  ]);
  assert.equal(b.local.apiToken, 'newer-fixture-token');
  assert.equal(b.local.serverUrl, 'http://localhost:18001');
  assert.deepEqual(b.sync, {});
});

test('a failed migration keeps the old configuration and can safely retry', async () => {
  const b = storageFixture();
  const save = b.storage.local.set;
  b.storage.local.set = async () => { throw new Error('fixture storage unavailable'); };
  const settings = b.context();
  await assert.rejects(settings.readSettings({ apiToken: '' }), /storage unavailable/);
  assert.equal(b.sync.apiToken, 'legacy-fixture-token');
  b.storage.local.set = save;
  assert.equal((await settings.readSettings({ apiToken: '' })).apiToken, 'legacy-fixture-token');
  assert.deepEqual(b.sync, {});
});
