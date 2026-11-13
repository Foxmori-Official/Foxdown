import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.FOXDOWN_BIN_DIR || path.join(root, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch);
const exe = process.platform === 'win32' ? '.exe' : '';
const mediaBin = process.platform === 'darwin' ? path.join(bin, 'media/bin') : bin;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foxdown-smoke-'));
const data = path.join(temp, 'data');
const downloads = path.join(temp, 'downloads');
const content = Buffer.from('Foxdown local download fixture\n'.repeat(2048));
const replacement = Buffer.alloc(content.length, 0x42);
let servedFile = content;
const token = 'desktop-smoke-fixture';
let backend;
let fixture;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  server.close();
  await once(server, 'close');
  return port;
}

try {
  execFileSync(path.join(bin, 'aria2c' + exe), ['--version'], { stdio: 'pipe' });
  execFileSync(path.join(mediaBin, 'ffprobe' + exe), ['-version'], { stdio: 'pipe' });
  execFileSync(path.join(mediaBin, 'ffmpeg' + exe), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x96:r=10',
    '-t', '2', '-c:v', 'mpeg2video', '-f', 'hls', 'sample.m3u8',
  ], { cwd: temp, stdio: 'pipe', timeout: 20000 });

  fixture = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    try {
      const file = name === 'file.bin' ? servedFile : await fs.readFile(path.join(temp, path.basename(name)));
      const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : name.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': file.length });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch { response.writeHead(404).end(); }
  });
  const fixtureOrigin = `http://127.0.0.1:${await listen(fixture)}`;
  const apiPort = await freePort();
  const rpcPort = await freePort();
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    btTrackerAutoUpdate: false, enableDht: false, btEnableLpd: false, rpcPort,
  }));
  backend = spawn(process.execPath, [path.join(root, 'server/src/index.js')], {
    env: {
      ...process.env, KIMI_HOST: '127.0.0.1', KIMI_PORT: String(apiPort),
      DATA_DIR: data, DOWNLOAD_DIR: downloads, FOXDOWN_BIN_DIR: bin, API_TOKEN: token,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const readyTimeout = AbortSignal.timeout(20000);
  const [message] = await Promise.race([
    once(backend, 'message', { signal: readyTimeout }),
    once(backend, 'exit', { signal: readyTimeout }).then(([code]) => { throw new Error(`Backend exited (${code})`); }),
  ]);
  assert.equal(message.type, 'ready');
  const origin = `http://127.0.0.1:${apiPort}`;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function api(route, body) {
    const response = await fetch(origin + '/api/v1' + route, {
      headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  const health = await api('/health');
  assert.ok(health.aria2 && health.ffmpeg && health.app === 'foxdown');
  assert.equal((await fetch(origin + '/api/v1/settings')).status, 401);
  assert.equal((await fetch(origin + '/api/v1/demo-file')).status, 200);

  async function waitComplete(task) {
    for (let attempt = 0; ; attempt++) {
      const status = await api(`/tasks/${task.engine}/${task.id}`);
      if (status.status === 'complete') return status;
      assert.ok(status.status !== 'error' && attempt < 60, JSON.stringify(status));
      await sleep(250);
    }
  }
  const fileRequest = { url: fixtureOrigin + '/file.bin' };
  const file = await api('/tasks', fileRequest);
  const stream = await api('/tasks', { url: fixtureOrigin + '/sample.m3u8', stream: { mux: true } });
  await Promise.all([waitComplete(file), waitComplete(stream)]);
  servedFile = replacement;
  const duplicate = await waitComplete(await api('/tasks', fileRequest));
  assert.equal(duplicate.name, 'file.1.bin');
  const named = await waitComplete(await api('/tasks', { ...fileRequest, options: { out: 'file.bin' } }));
  assert.equal(named.name, 'file (1).bin');
  assert.deepEqual(await fs.readFile(path.join(downloads, 'file.bin')), content);
  assert.deepEqual(await fs.readFile(path.join(downloads, duplicate.name)), replacement);
  assert.deepEqual(await fs.readFile(path.join(downloads, named.name)), replacement);
  const sidecar = path.join(downloads, 'file.bin.aria2');
  await fs.writeFile(sidecar, 'unrelated resume data');
  const withSidecar = await waitComplete(await api('/tasks', fileRequest));
  assert.equal(withSidecar.name, 'file (2).bin');
  assert.deepEqual(await fs.readFile(path.join(downloads, withSidecar.name)), replacement);
  assert.equal(await fs.readFile(sidecar, 'utf8'), 'unrelated resume data');
  const mp4 = (await fs.readdir(downloads)).find(name => name.endsWith('.mp4'));
  assert.ok(mp4, 'HLS remux must produce an MP4');
  execFileSync(path.join(mediaBin, 'ffprobe' + exe), ['-v', 'error', path.join(downloads, mp4)], { stdio: 'pipe' });

  const pending = await api('/tasks', { ...fileRequest, options: { startAt: Date.now() + 3600000, out: 'later.bin' } });
  const failed = await api('/tasks', { url: fixtureOrigin + '/missing.bin' });
  for (let attempt = 0; ; attempt++) {
    if ((await api(`/tasks/aria2/${failed.id}`)).status === 'error') break;
    assert.ok(attempt < 60, 'missing file should fail');
    await sleep(250);
  }
  const filesBefore = await fs.readdir(downloads);
  const bytesBefore = await Promise.all(filesBefore.map(name => fs.readFile(path.join(downloads, name))));
  assert.deepEqual(await api('/tasks/clear-completed', { deleteFiles: true }), { removed: 5, failed: 0 });
  const { tasks } = await api('/tasks');
  assert.deepEqual(new Map(tasks.map(task => [task.id, task.status])), new Map([[pending.id, 'paused'], [failed.id, 'error']]));
  assert.deepEqual(await fs.readdir(downloads), filesBefore);
  assert.deepEqual(await Promise.all(filesBefore.map(name => fs.readFile(path.join(downloads, name)))), bytesBefore);
  assert.deepEqual(await api('/tasks/clear-completed', {}), { removed: 0, failed: 0 });
  await fs.writeFile(path.join(temp, 'missing.bin'), content);
  const retried = await api(`/tasks/aria2/${failed.id}/action`, { action: 'retry' });
  const retriedTask = await waitComplete({ ...retried, engine: 'aria2' });
  assert.deepEqual(await fs.readFile(path.join(downloads, retriedTask.name)), content);
  console.log(`Native engine smoke passed (${process.platform}/${process.arch}): HTTP duplicates, HLS → MP4 and clearing completed records with files intact.`);
} finally {
  if (backend?.connected) {
    backend.send({ type: 'shutdown' }, () => {});
    await once(backend, 'exit', { signal: AbortSignal.timeout(7000) }).catch(() => backend.kill());
  }
  fixture?.closeAllConnections();
  fixture?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
