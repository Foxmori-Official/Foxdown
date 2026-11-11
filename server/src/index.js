import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, ARIA2_RPC_PORT, API_PORT, API_HOST, DATA_DIR } from './config.js';
import { Aria2Engine } from './aria2/engine.js';
import { Aria2Rpc } from './aria2/rpc.js';
import { TaskStore } from './tasks/store.js';
import { StreamManager } from './stream/index.js';
import { ApiServer } from './api/server.js';
import { UpnpManager } from './upnp/index.js';
import { TaskScheduler } from './tasks/scheduler.js';
import { HookRunner } from './hooks/index.js';
import { SpeedHistory } from './stats/history.js';
import { sleep } from './util/helpers.js';

async function waitForAria2(rpc, engine, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (engine.lastError) throw engine.lastError;
    try { const v = await rpc.getVersion(); return v; } catch { await sleep(300); }
  }
  throw new Error('aria2 did not become ready in time');
}

async function main() {
  console.log('[boot] Foxdown server starting...');
  // aria2's OpenSSL build cannot read the Windows CA store - feed it Node's
  // bundled Mozilla roots instead.
  const tls = await import('node:tls');
  const caFile = path.join(DATA_DIR, 'cacert.pem');
  fs.writeFileSync(caFile, tls.rootCertificates.join('\n') + '\n');

  const settings = loadSettings();
  const store = new TaskStore();
  const engine = new Aria2Engine(settings);
  const rpc = new Aria2Rpc(settings.rpcSecret, settings.rpcPort || ARIA2_RPC_PORT);
  const stream = new StreamManager(store, settings);
  const upnp = new UpnpManager(settings);
  const scheduler = new TaskScheduler(rpc, stream, store);
  const hooks = new HookRunner(settings);
  const speedHistory = new SpeedHistory();
  const api = new ApiServer({ engine, rpc, store, stream, settings, upnp, scheduler, hooks, speedHistory });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(api._poll);
    scheduler.stop();
    try { await stream.shutdown(); } catch {}
    try { await rpc.saveSession(); } catch {}
    rpc.close();
    try { await upnp.destroy(); } catch {}
    await engine.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.send) {
    process.once('disconnect', shutdown);
    process.on('message', message => { if (message?.type === 'shutdown') void shutdown(); });
  }

  engine.on('error', error => console.error('[aria2]', error.message));
  try {
    engine.start();
    rpc.connect();
    const version = await waitForAria2(rpc, engine);
    console.log(`[boot] aria2 ready, version ${version.version}`);
    await api.listen();
  } catch (error) {
    rpc.close();
    await engine.stop();
    throw error;
  }
  if (process.connected) process.send({ type: 'ready' });
  upnp.apply(settings).catch(() => {});

  // auto-update trackers on boot when enabled and list is empty
  if (settings.btTrackerAutoUpdate && !settings.btTracker) {
    setTimeout(async () => {
      try {
        const { fetchTrackerList } = await import('./util/trackers.js');
        const { trackers, count, source } = await fetchTrackerList(settings.btTrackerSource);
        settings.btTracker = trackers;
        const { saveSettings } = await import('./config.js');
        saveSettings(settings);
        rpc.changeGlobalOption({ 'bt-tracker': trackers }).catch(() => {});
        console.log(`[boot] tracker list updated (${count} trackers from ${source})`);
      } catch (e) { console.log('[boot] tracker auto-update failed:', e.message); }
    }, 3000);
  }

  // Stream error listeners must be registered before restoring scheduled jobs.
  scheduler.start().catch(e => console.error('[scheduler] restore failed:', e.message));

  console.log(`[boot] done. Web UI & API: http://${API_HOST}:${API_PORT}`);
}

main().catch((e) => { console.error('[boot] fatal:', e.message); process.exit(1); });
