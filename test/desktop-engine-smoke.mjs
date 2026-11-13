import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createCipheriv } from 'node:crypto';

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
    '-t', '4', '-c:v', 'mpeg2video', '-g', '10', '-hls_time', '1', '-hls_playlist_type', 'vod', '-f', 'hls', 'sample.m3u8',
  ], { cwd: temp, stdio: 'pipe', timeout: 20000 });
  execFileSync(path.join(mediaBin, 'ffmpeg' + exe), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x96:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4',
    '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '1', 'sample.mpd',
  ], { cwd: temp, stdio: 'pipe', timeout: 20000 });
  const dash = await fs.readFile(path.join(temp, 'sample.mpd'), 'utf8');
  const audioOnly = dash.replace(/<AdaptationSet\b[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/, '');
  assert.notEqual(audioOnly, dash, 'The audio-only fixture must remove the video track');
  await fs.writeFile(path.join(temp, 'audio.mpd'), audioOnly);
  const playlist = await fs.readFile(path.join(temp, 'sample.m3u8'), 'utf8');
  const key = Buffer.alloc(16, 0x12);
  await fs.writeFile(path.join(temp, 'key.bin'), key);
  let sequence = 0;
  const encrypted = [];
  for (const line of playlist.split('\n')) {
    if (!line || line.startsWith('#')) { encrypted.push(line); continue; }
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(sequence), 8);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const plain = await fs.readFile(path.join(temp, line));
    const segment = `encrypted-${sequence++}.ts`;
    await fs.writeFile(path.join(temp, segment), Buffer.concat([cipher.update(plain), cipher.final()]));
    encrypted.push(segment);
  }
  assert.ok(sequence >= 4, 'The HLS fixture must contain several real segments');
  await fs.writeFile(path.join(temp, 'encrypted.m3u8'), encrypted.join('\n')
    .replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'));

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
      ...process.env, FOXDOWN_HOST: '127.0.0.1', FOXDOWN_PORT: String(apiPort),
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
  const encryptedStream = await api('/tasks', { url: fixtureOrigin + '/encrypted.m3u8', stream: { mux: true } });
  const dashStream = await api('/tasks', { url: fixtureOrigin + '/sample.mpd', stream: { mux: true } });
  const audioStream = await api('/tasks', { url: fixtureOrigin + '/audio.mpd', stream: { mux: true } });
  await Promise.all([file, stream, encryptedStream, dashStream, audioStream].map(waitComplete));
  assert.deepEqual(await fs.readFile(path.join(downloads, 'encrypted.mp4')), await fs.readFile(path.join(downloads, 'sample.mp4')));
  const originalStream = await fs.readFile(path.join(downloads, 'sample.mp4'));
  const duplicateStreams = await Promise.all([1, 2].map(() => api('/tasks', {
    url: fixtureOrigin + '/sample.m3u8', options: { out: 'sample.mp4' }, stream: { mux: true },
  })));
  const streamResults = await Promise.all(duplicateStreams.map(waitComplete));
  assert.deepEqual(new Set(streamResults.map(task => task.name)), new Set(['sample (1).mp4', 'sample (2).mp4']));
  assert.deepEqual(await fs.readFile(path.join(downloads, 'sample.mp4')), originalStream);
  for (const task of streamResults) assert.deepEqual(await fs.readFile(task.outputFiles[0]), originalStream);
  function tracks(name) {
    return JSON.parse(execFileSync(path.join(mediaBin, 'ffprobe' + exe), [
      '-v', 'error', '-show_streams', '-of', 'json', path.join(downloads, name),
    ], { encoding: 'utf8', stdio: 'pipe' })).streams.map(track => track.codec_type).sort();
  }
  assert.deepEqual(tracks('sample.mkv'), ['audio', 'video']);
  assert.deepEqual(tracks('audio.mp4'), ['audio']);
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
  assert.deepEqual(await api('/tasks/clear-completed', { deleteFiles: true }), { removed: 10, failed: 0 });
  const { tasks } = await api('/tasks');
  assert.deepEqual(new Map(tasks.map(task => [task.id, task.status])), new Map([[pending.id, 'paused'], [failed.id, 'error']]));
  assert.deepEqual(await fs.readdir(downloads), filesBefore);
  assert.deepEqual(await Promise.all(filesBefore.map(name => fs.readFile(path.join(downloads, name)))), bytesBefore);
  assert.deepEqual(await api('/tasks/clear-completed', {}), { removed: 0, failed: 0 });
  await fs.writeFile(path.join(temp, 'missing.bin'), content);
  const retried = await api(`/tasks/aria2/${failed.id}/action`, { action: 'retry' });
  const retriedTask = await waitComplete({ ...retried, engine: 'aria2' });
  assert.deepEqual(await fs.readFile(path.join(downloads, retriedTask.name)), content);
  console.log(`Native engine smoke passed (${process.platform}/${process.arch}): HTTP/HLS duplicates, AES-128 HLS, DASH video/audio and audio-only mux, clearing completed records with files intact.`);
} finally {
  if (backend?.connected) {
    backend.send({ type: 'shutdown' }, () => {});
    await once(backend, 'exit', { signal: AbortSignal.timeout(7000) }).catch(() => backend.kill());
  }
  fixture?.closeAllConnections();
  fixture?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
