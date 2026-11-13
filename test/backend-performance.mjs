// Standalone local benchmark: real API + aria2, synthetic completed task history.
// No machine-dependent latency assertion. Always checks response correctness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foxdown-performance-'));
const taskCount = 500;
const requestCount = 10000;
const concurrency = 16;
const routes = ['/tasks', '/stats', '/dashboard', '/health'];
const token = 'isolated-performance-fixture';
let backend;

async function freePort() {
  const server = http.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function message(type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { backend.off('message', onMessage); reject(new Error(`IPC timeout: ${type}`)); }, 20000);
    function onMessage(value) {
      if (value?.type !== type) return;
      clearTimeout(timeout);
      backend.off('message', onMessage);
      resolve(value);
    }
    backend.on('message', onMessage);
  });
}
async function metrics(reset = false) {
  const reply = message('benchmark-metrics');
  backend.send({ type: 'benchmark-metrics', reset });
  return reply;
}
const rounded = number => Number(number.toFixed(2));
function distribution(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50Ms: rounded(percentile(0.5)), p95Ms: rounded(percentile(0.95)), maxMs: rounded(sorted.at(-1)) };
}

try {
  const data = path.join(temp, 'data');
  const downloads = path.join(temp, 'downloads');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    rpcPort: await freePort(), btTrackerAutoUpdate: false, enableDht: false, btEnableLpd: false,
  }));
  await fs.writeFile(path.join(data, 'db.json'), JSON.stringify({ meta: {}, streamTasks: Array.from({ length: taskCount }, (_, index) => ({
    id: `history-${index}`, engine: 'stream', backend: 'native', status: 'complete',
    name: `Completed video ${index}.mp4`, url: `https://fixture.invalid/${index}.m3u8`,
    saveDir: downloads, totalLength: 104857600, completedLength: 104857600,
    outputFiles: [], createdAt: Date.now() - index * 1000,
    progress: { totalSegments: 100, doneSegments: 100, speed: 0 },
  })) }));
  const hook = `import { monitorEventLoopDelay } from 'node:perf_hooks';
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    process.on('message', value => {
      if (value?.type !== 'benchmark-metrics') return;
      if (value.reset) delay.reset();
      process.send({ type: 'benchmark-metrics', memory: process.memoryUsage(), cpu: process.cpuUsage(),
        eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6 });
    });`;
  const port = await freePort();
  backend = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(hook), path.join(root, 'server/src/index.js')], {
    env: { ...process.env, FOXDOWN_HOST: '127.0.0.1', FOXDOWN_PORT: String(port), DATA_DIR: data,
      DOWNLOAD_DIR: downloads, API_TOKEN: token,
      FOXDOWN_BIN_DIR: path.join(root, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await message('ready');
  async function request(route) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    if (route === '/tasks') assert.equal(value.tasks.length, taskCount);
  }
  for (let index = 0; index < 24; index++) await request(routes[index % routes.length]);
  const before = await metrics(true);
  const samples = Object.fromEntries(routes.map(route => [route, []]));
  let next = 0;
  const began = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++;
      if (index >= requestCount) return;
      const route = routes[index % routes.length];
      const start = performance.now();
      await request(route);
      samples[route].push(performance.now() - start);
    }
  }));
  const durationMs = performance.now() - began;
  const after = await metrics();
  const cpuMicros = after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
  const report = {
    platform: process.platform + '/' + process.arch, node: process.version, taskCount, requestCount, concurrency,
    seconds: rounded(durationMs / 1000), requestsPerSecond: rounded(requestCount * 1000 / durationMs),
    latency: Object.fromEntries(routes.map(route => [route, distribution(samples[route])])),
    server: { rssBeforeMiB: rounded(before.memory.rss / 1024 ** 2), rssAfterMiB: rounded(after.memory.rss / 1024 ** 2),
      heapAfterMiB: rounded(after.memory.heapUsed / 1024 ** 2), cpuCorePercent: rounded(cpuMicros / durationMs / 10),
      eventLoopP95Ms: rounded(after.eventLoopP95Ms), eventLoopMaxMs: rounded(after.eventLoopMaxMs) },
    failures: 0, finishedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.FOXDOWN_PERFORMANCE_REPORT) await fs.writeFile(process.env.FOXDOWN_PERFORMANCE_REPORT, JSON.stringify(report, null, 2) + '\n');
} finally {
  if (backend?.connected) {
    backend.send({ type: 'shutdown' }, () => {});
    await once(backend, 'exit', { signal: AbortSignal.timeout(7000) }).catch(() => backend.kill());
  }
  await fs.rm(temp, { recursive: true, force: true });
}
