import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foxdown-multiconnection-'));
const downloads = path.join(temp, 'downloads');
const token = randomBytes(16).toString('hex');
const bin = path.join(root, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch);
const total = 512 * 1024 * 1024;
const block = randomBytes(1024 * 1024);
const ranges = [];
let concurrent = 0, peakRequests = 0;
let backend, fixture;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  fixture = http.createServer(async (request, response) => {
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : total - 1;
    if (start > end || end >= total) return response.writeHead(416).end();
    response.writeHead(match ? 206 : 200, {
      'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1, ETag: '"foxdown-512m-fixture"',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    });
    if (request.method === 'HEAD') return response.end();
    ranges.push({ start, end, status: match ? 206 : 200 });
    concurrent++;
    peakRequests = Math.max(peakRequests, concurrent);
    response.once('close', () => { concurrent--; });
    try {
      for (let offset = start; offset <= end && !response.destroyed;) {
        const size = Math.min(64 * 1024, end - offset + 1, block.length - offset % block.length);
        if (!response.write(block.subarray(offset % block.length, offset % block.length + size))) {
          await new Promise(resolve => {
            const done = () => {
              response.removeListener('drain', done);
              response.removeListener('close', done);
              response.removeListener('error', done);
              resolve();
            };
            response.once('drain', done);
            response.once('close', done);
            response.once('error', done);
          });
        }
        offset += size;
        await delay(2);
      }
      response.end();
    } catch { response.destroy(); }
  });
  const fixtureOrigin = 'http://127.0.0.1:' + await listen(fixture);
  const port = await freePort();
  const rpcPort = await freePort();
  const data = path.join(temp, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    rpcPort, maxConnectionPerServer: 8, split: 8, minSplitSize: '1M',
    maxOverallDownloadLimit: 16 * 1024 * 1024,
    btTrackerAutoUpdate: false, enableDht: false, btEnableLpd: false,
  }));
  backend = spawn(process.execPath, [path.join(root, 'server/src/index.js')], {
    env: { ...process.env, FOXDOWN_HOST: '127.0.0.1', FOXDOWN_PORT: String(port),
      DATA_DIR: data, DOWNLOAD_DIR: downloads, FOXDOWN_BIN_DIR: bin, API_TOKEN: token },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [message] = await Promise.race([
    once(backend, 'message', { signal: AbortSignal.timeout(20000) }),
    once(backend, 'exit', { signal: AbortSignal.timeout(20000) }).then(([code]) => { throw new Error('Backend exited ' + code); }),
  ]);
  assert.equal(message.type, 'ready');
  const base = 'http://127.0.0.1:' + port;
  async function api(route, body) {
    const response = await fetch(base + '/api/v1' + route, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(6000),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  async function run(url, name, expectedSize, expectedHash, pause = false) {
    const created = await api('/tasks', { url, options: { out: name, split: 8, maxConnectionPerServer: 8 } });
    let maxConnections = 0, resumed = false;
    const began = Date.now();
    for (;;) {
      const task = await api('/tasks/aria2/' + created.id);
      maxConnections = Math.max(maxConnections, task.connections);
      assert.notEqual(task.status, 'error', JSON.stringify(task));
      assert.ok(Date.now() - began < 240000, 'Large-file test timed out');
      if (pause && !resumed && task.completedLength >= 32 * 1024 * 1024) {
        await api('/tasks/aria2/' + created.id + '/action', { action: 'pause' });
        for (let attempt = 0; ; attempt++) {
          const state = await api('/tasks/aria2/' + created.id);
          if (state.status === 'paused') break;
          assert.ok(attempt < 50);
          await delay(100);
        }
        await api('/tasks/aria2/' + created.id + '/action', { action: 'resume' });
        resumed = true;
      }
      if (task.status === 'complete') break;
      await delay(100);
    }
    const file = path.join(downloads, name);
    const bytes = (await fs.stat(file)).size;
    const hash = await sha256(file);
    assert.equal(bytes, expectedSize);
    assert.equal(hash, expectedHash);
    assert.ok(maxConnections > 1, 'The real engine must use simultaneous connections');
    const result = { url, bytes, sha256: hash, maxConnections, pauseResume: resumed, seconds: (Date.now() - began) / 1000 };
    console.log(JSON.stringify(result));
    return result;
  }
  const expected = createHash('sha256');
  for (let i = 0; i < total / block.length; i++) expected.update(block);
  const local = await run(fixtureOrigin + '/512MiB.bin', '512MiB.bin', total, expected.digest('hex'), true);
  assert.ok(peakRequests > 1);
  assert.ok(ranges.some(range => range.start > 0 && range.status === 206));
  Object.assign(local, { rangeRequests: ranges.length, peakRequests, ranges });

  const origin = 'https://nodejs.org/dist/v22.23.5/';
  const fileName = 'node-v22.23.5.tar.gz';
  const checksums = await (await fetch(origin + 'SHASUMS256.txt')).text();
  const officialHash = checksums.split('\n').find(line => line.endsWith('  ' + fileName))?.split(/\s+/)[0];
  assert.match(officialHash || '', /^[a-f0-9]{64}$/);
  const metadata = await fetch(origin + fileName, { method: 'HEAD' });
  assert.ok(metadata.ok && metadata.headers.get('accept-ranges') === 'bytes');
  const external = await run(origin + fileName, fileName, Number(metadata.headers.get('content-length')), officialHash);
  const report = { platform: process.platform + '/' + process.arch, node: process.version, configuredConnections: 8,
    local, external, finishedAt: new Date().toISOString() };
  if (process.env.FOXDOWN_DOWNLOAD_REPORT) {
    await fs.mkdir(path.dirname(process.env.FOXDOWN_DOWNLOAD_REPORT), { recursive: true });
    await fs.writeFile(process.env.FOXDOWN_DOWNLOAD_REPORT, JSON.stringify(report, null, 2));
  }
  console.log('Large-file verification passed: parallel HTTP ranges, pause/resume and both SHA-256 checks.');
} finally {
  if (backend?.connected) {
    backend.send({ type: 'shutdown' }, () => {});
    await once(backend, 'exit', { signal: AbortSignal.timeout(7000) }).catch(() => backend.kill());
  }
  fixture?.closeAllConnections();
  fixture?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
