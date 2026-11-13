import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { isolateServer } from '../helpers/server-fixture.mjs';
import { parseMpd } from '../../server/src/stream/dash.js';

// These are the quote boundaries called out by the external audit. Both are
// valid XML attribute values and must preserve the attributes that follow.
test('DASH attributes containing greater-than signs preserve track and segment metadata', () => {
  for (const quote of ['"', "'"]) {
    const document = `<MPD mediaPresentationDuration="PT4S"><Period>
      <AdaptationSet label=${quote}1080p > 720p${quote} mimeType="video/mp4">
        <Representation id="video" bandwidth="1234">
          <SegmentTemplate media="segment-$Number$.m4s" initialization="init.mp4" duration="2" timescale="1"/>
        </Representation>
      </AdaptationSet></Period></MPD>`;
    const result = parseMpd(document, 'https://fixture.invalid/movie.mpd');
    assert.equal(result.representations.length, 1);
    const [track] = result.representations;
    assert.equal(track.id, 'video');
    assert.equal(track.mimeType, 'video/mp4');
    assert.equal(track.initUrl, 'https://fixture.invalid/init.mp4');
    assert.deepEqual(track.segments.map(segment => segment.url), [
      'https://fixture.invalid/segment-1.m4s', 'https://fixture.invalid/segment-2.m4s',
    ]);
  }
});

test('audit fixes preserve authorized settings, extension handoff, and persisted task data', async t => {
  const root = isolateServer(t);
  const { ApiServer } = await import('../../server/src/api/server.js');
  const { TaskStore } = await import('../../server/src/tasks/store.js');
  const { DEFAULT_SETTINGS, DATA_DIR } = await import('../../server/src/config.js');
  const store = new TaskStore();
  const settings = structuredClone(DEFAULT_SETTINGS);
  let restarts = 0;
  let connections = 0;
  let additions = 0;
  const rpc = Object.assign(new EventEmitter(), {
    tellActive: async () => [], tellWaiting: async () => [], tellStopped: async () => [],
    getGlobalStat: async () => ({}), reconnect: async () => { connections++; },
    addUri: async () => String(++additions),
  });
  const stream = Object.assign(new EventEmitter(), { listTasks: () => [], globalStats: () => ({}) });
  const api = new ApiServer({ engine: { restart: async () => { restarts++; } }, rpc, stream, store, settings });
  const server = http.createServer(api.app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await store.flush();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const extension = 'chrome-extension://' + 'a'.repeat(32);
  async function request(route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
    return fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }

  await t.test('invalid types, unknown keys and unsafe nested settings are rejected atomically', async () => {
    for (const patch of [
      { unknownSetting: true }, { checkCertificate: 'false' }, { rpcListenAll: 1 },
      { rpcPort: 0 }, { rpcPort: 65536 }, { split: 1.5 }, { streamThreadCount: 10000 },
      { streamTimeoutMs: null }, { seedRatio: -1 }, { userAgent: 'agent\r\nInjected: value' },
      { minSplitSize: '0' }, { minSplitSize: '1023' }, { minSplitSize: '1025M' },
      { minSplitSize: '1.5M' }, { diskCache: '1G' },
      { theme: '' }, { locale: 'unsupported' }, { webhookUrl: 'file:///tmp/hook' }, { speedProfiles: [{ name: 'bad', down: -1, up: 0 }] },
      JSON.parse('{"__proto__":{"polluted":true}}'), [],
    ]) {
      const before = JSON.stringify(settings);
      assert.equal((await request('/api/v1/settings', patch, {}, 'PUT')).status, 400, JSON.stringify(patch));
      assert.equal(JSON.stringify(settings), before);
    }
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(restarts, 0);
  });
  await t.test('continueDownloads already has the correct spelling and changing it restarts the engine', async () => {
    const response = await request('/api/v1/settings', { continueDownloads: false }, {}, 'PUT');
    assert.equal(response.status, 200);
    assert.equal(settings.continueDownloads, false);
    assert.equal(restarts, 1);
    assert.equal((await request('/api/v1/settings', { rpcSecret: 'new-fixture-secret' }, {}, 'PUT')).status, 200);
    assert.equal(connections, 1);
  });
  await t.test('unpaired extensions cannot read credentials, modify settings, execute MCP or test hooks', async () => {
    const origin = { Origin: extension };
    assert.equal((await request('/api/v1/health', undefined, origin)).status, 200);
    assert.equal((await request('/api/v1/settings', undefined, origin)).status, 403);
    assert.equal((await request('/api/v1/settings', { rpcListenAll: true }, origin, 'PUT')).status, 403);
    for (const route of ['/api/v1/hooks/test', '/api/v1/reveal', '/api/v1/tasks/clear-completed', '/mcp']) {
      assert.equal((await request(route, { url: 'http://127.0.0.1', path: root }, origin)).status, 403);
    }
    assert.equal(settings.rpcListenAll, false);
    // Real Chrome workers can send Fetch Metadata without an Origin header.
    const workerHeaders = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors' };
    assert.equal((await request('/api/v1/settings', undefined, workerHeaders)).status, 403);
    assert.equal((await request('/api/v1/hooks/test', { url: base }, workerHeaders)).status, 403);
    assert.equal((await request('/api/v1/settings', undefined, { ...workerHeaders, Origin: base })).status, 403);
  });
  await t.test('tokenless extension downloads stay inside the configured directory, including symlink targets', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const post = directory => request('/api/v1/tasks', {
      url: 'http://fixture.invalid/download.bin', options: { dir: directory },
    }, { Origin: extension });
    assert.equal((await post(outside)).status, 403);
    assert.equal((await request('/api/v1/tasks', {
      url: 'http://fixture.invalid/worker.bin', options: { dir: outside },
    }, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors' })).status, 403);
    const link = path.join(settings.downloadDir, 'escape');
    try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
    if (await fs.lstat(link).catch(() => null)) assert.equal((await post(path.join(link, 'new-directory'))).status, 403);
    assert.equal((await post(path.join(settings.downloadDir, 'subfolder'))).status, 200);
    assert.equal(additions, 1);
  });
  await t.test('Bearer-authenticated clients keep custom directories and full settings access', async () => {
    settings.apiToken = 'authorized-fixture-token';
    const headers = { Origin: extension, Authorization: 'Bearer ' + settings.apiToken };
    assert.equal((await request('/api/v1/settings', undefined, headers)).status, 200);
    assert.equal((await request('/api/v1/tasks', {
      url: 'http://fixture.invalid/custom.bin', options: { dir: path.join(root, 'outside') },
    }, headers)).status, 200);
    assert.equal((await request('/api/v1/settings', undefined, { Authorization: 'Bearer wrong-token' })).status, 401);
    settings.apiToken = '';
  });
  await t.test('revealing an unrelated path is rejected before starting a system process', async () => {
    assert.equal((await request('/api/v1/reveal', { path: path.join(root, 'outside') })).status, 403);
  });
  await t.test('atomic saves serialize concurrent flushes and retry after a failed rename', async () => {
    await store.flush();
    const rename = fs.rename;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    fs.rename = async (...args) => { entered(); await held; return rename(...args); };
    try {
      store.setMeta('first-write', { value: 1 });
      const first = store.flush();
      await started;
      store.setMeta('second-write', { value: 2 });
      const second = store.flush();
      release();
      await Promise.all([first, second]);
    } finally { fs.rename = rename; }
    const file = path.join(DATA_DIR, 'db.json');
    const previous = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(previous).meta['second-write'].value, 2);
    store.setMeta('retry-write', { value: 3 });
    fs.rename = async () => { throw new Error('fixture rename failure'); };
    try { await assert.rejects(store.flush(), /fixture rename failure/); }
    finally { fs.rename = rename; }
    assert.equal(await fs.readFile(file, 'utf8'), previous);
    await store.flush();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).meta['retry-write'].value, 3);
    assert.deepEqual((await fs.readdir(DATA_DIR)).filter(name => name.endsWith('.tmp')), []);
  });
});
