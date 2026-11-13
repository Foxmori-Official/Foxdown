import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { isolateServer } from '../helpers/server-fixture.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const waitFor = async (predicate) => {
  const until = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting for local server');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('isolated REST and WebSocket authentication / state delivery', { timeout: 15000 }, async t => {
  isolateServer(t);
  const { ApiServer } = await import('../../server/src/api/server.js');
  const { TaskStore } = await import('../../server/src/tasks/store.js');
  const store = new TaskStore();
  const settings = { apiToken: 'test-only-token', locale: 'en' };
  let snapshots = 0;
  const rpc = Object.assign(new EventEmitter(), {
    tellActive: async () => { snapshots++; return [{ gid: 'sample', status: 'active', files: [] }]; },
    tellWaiting: async () => [], tellStopped: async () => [],
    getGlobalStat: async () => ({ downloadSpeed: '10', uploadSpeed: '2', numActive: '1' }),
  });
  const stream = Object.assign(new EventEmitter(), {
    listTasks: () => [{ id: 'stream-sample', engine: 'stream' }],
    globalStats: () => ({ downloadSpeed: 5, numActive: 1 }),
  });
  const api = new ApiServer({ engine: {}, rpc, stream, store, settings });
  const server = http.createServer(api.app);
  api.startEventPush(server);
  const sockets = new Set();
  t.after(async () => {
    clearInterval(api._poll);
    clearTimeout(store._saveTimer);
    for (const ws of sockets) ws.terminate();
    for (const ws of api.wss.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const wsbase = base.replace('http:', 'ws:') + '/ws';
  const connect = (url, options) => {
    const ws = new WebSocket(url, options);
    sockets.add(ws);
    return ws;
  };

  await t.test('missing or wrong REST tokens return 401 without invoking task RPCs', async () => {
    for (const headers of [{}, { Authorization: 'Bearer wrong-test-token' }]) {
      const response = await fetch(`${base}/api/v1/settings`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    assert.equal(snapshots, 0);
  });
  await t.test('Bearer and query authentication return settings; preflight remains accessible', async () => {
    for (const [suffix, headers] of [['', { Authorization: 'Bearer test-only-token' }], ['?token=test-only-token', {}]]) {
      const response = await fetch(`${base}/api/v1/settings${suffix}`, { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).locale, 'en');
    }
    assert.equal((await fetch(`${base}/api/v1/settings`, { method: 'OPTIONS' })).status, 204);
  });
  await t.test('MCP uses the same API token as task creation', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    for (const token of ['', 'wrong-test-token', 'test-only-token']) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body,
      });
      assert.equal(response.status, token === 'test-only-token' ? 200 : 401);
    }
  });
  await t.test('WebSocket rejects missing and wrong credentials before sending any state', async () => {
    for (const suffix of ['', '?token=wrong-test-token']) {
      const ws = connect(wsbase + suffix);
      const status = await new Promise((resolve, reject) => {
        ws.once('open', () => reject(new Error('unexpected authenticated connection')));
        ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
        ws.on('error', () => {});
      });
      assert.equal(status, 401);
    }
    assert.equal(snapshots, 0);
  });

  let client;
  await t.test('valid WebSocket receives immediate merged state, even without speed history', async () => {
    client = connect(wsbase + '?token=test-only-token');
    const messages = [];
    client.on('message', data => messages.push(JSON.parse(data)));
    await once(client, 'open');
    await waitFor(() => messages.some(m => m.type === 'state'));
    const state = messages.find(m => m.type === 'state');
    assert.deepEqual(state.tasks.map(task => task.id), ['sample', 'stream-sample']);
    assert.equal(state.stats.downloadSpeed, 15);
    assert.equal(state.stats.numActive, 2);
    const before = snapshots;
    await waitFor(() => snapshots > before); // periodic push without speedHistory
  });
  await t.test('pushState is single-flight and recovers after a failed snapshot', async () => {
    let release;
    let count = 0;
    const original = api._listAria2Tasks;
    api._listAria2Tasks = () => { count++; return new Promise(resolve => { release = resolve; }); };
    const first = api.pushState();
    await api.pushState();
    assert.equal(count, 1);
    release([]);
    await first;
    api._listAria2Tasks = async () => { throw new Error('isolated RPC failure'); };
    await assert.rejects(api.pushState(), /isolated RPC failure/);
    api._listAria2Tasks = original;
    await api.pushState();
    assert.equal(api._pushing, false);
  });
  await t.test('token rotation disconnects previously authorized sockets', async () => {
    const closed = once(client, 'close');
    const response = await fetch(`${base}/api/v1/settings`, {
      method: 'PUT', headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiToken: 'rotated-test-token' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await closed)[0], 1008);
    assert.equal((await fetch(`${base}/api/v1/settings?token=test-only-token`)).status, 401);
    const next = connect(wsbase, { headers: { Authorization: 'Bearer rotated-test-token' } });
    await once(next, 'open');
    const close = once(next, 'close'); next.close(); await close;
  });
  await t.test('empty token permits local unauthenticated REST and WS startup', async () => {
    settings.apiToken = '';
    assert.equal((await fetch(`${base}/api/v1/settings`)).status, 200);
    const ws = connect(wsbase);
    await once(ws, 'open');
    const close = once(ws, 'close'); ws.close(); await close;
  });
  await t.test('untrusted and opaque browser origins cannot read or change local state', async () => {
    for (const origin of ['https://untrusted.example', 'null', 'http://127.0.0.1:1']) {
      const headers = { Origin: origin, 'Content-Type': 'application/json' };
      for (const method of ['GET', 'OPTIONS', 'PUT']) {
        const response = await fetch(`${base}/api/v1/settings`, {
          method, headers, body: method === 'PUT' ? JSON.stringify({ postScript: 'blocked-script' }) : undefined,
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.has('access-control-allow-origin'), false);
      }
      assert.equal((await fetch(`${base}/mcp`, {
        method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/v1/settings`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(settings.postScript, undefined);
  });
  await t.test('a rebound Host is rejected even with its matching Origin or no Origin', async () => {
    const hostname = 'rebound.example:' + server.address().port;
    for (const headers of [{ Host: hostname }, { Host: hostname, Origin: 'http://' + hostname }]) {
      const status = await new Promise((resolve, reject) => {
        http.get(`${base}/api/v1/settings`, { headers }, res => { res.resume(); resolve(res.statusCode); }).once('error', reject);
      });
      assert.equal(status, 401);
    }
  });
  await t.test('extension access remains available and only the Web UI or Bearer token can set a script', async () => {
    const origin = 'chrome-extension://' + 'a'.repeat(32);
    const allowed = await fetch(`${base}/api/v1/settings`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    const patch = (postScript, headers, suffix = '') => fetch(`${base}/api/v1/settings${suffix}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ postScript }),
    });
    assert.equal((await patch('blocked-script', { Origin: origin })).status, 403);
    assert.equal((await patch('blocked-script', {})).status, 403);
    assert.equal((await patch('ui-script', { Origin: base })).status, 200);
    assert.equal(settings.postScript, 'ui-script');
    settings.apiToken = 'script-fixture-token';
    try {
      assert.equal((await patch('blocked-script', {}, '?token=script-fixture-token')).status, 403);
      assert.equal((await patch('authorized-script', { Authorization: 'Bearer script-fixture-token' })).status, 200);
      assert.equal(settings.postScript, 'authorized-script');
    } finally { settings.apiToken = ''; }
  });
  await t.test('WebSocket shares the Origin and DNS rebinding checks', async () => {
    for (const [headers, expected] of [
      [{ Origin: 'https://untrusted.example' }, 403],
      [{ Host: 'rebound.example', Origin: 'http://rebound.example' }, 401],
    ]) {
      const socket = connect(wsbase, { headers });
      const status = await new Promise((resolve, reject) => {
        socket.once('open', () => reject(new Error('unexpected WebSocket connection')));
        socket.once('unexpected-response', (_request, response) => {
          response.resume(); socket.terminate(); resolve(response.statusCode);
        });
        socket.on('error', () => {});
      });
      assert.equal(status, expected);
    }
  });
});
