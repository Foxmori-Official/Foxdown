import { EventEmitter } from 'node:events';
import { hasExternalStreamEngine } from '../config.js';
import { NativeStreamEngine } from './native.js';
import { ExternalStreamEngine } from './external.js';

/**
 * Unified stream-download facade. Two interchangeable backends:
 *  - native:   built-in HLS/DASH engine (native.js)
 *  - external: N_m3u8DL-RE.exe subprocess when present (external.js)
 *
 * Public contract (used by api/server.js):
 *   probe(url, headers) -> { format, live, name, variants:[{id,bandwidth,resolution,frameRate,codecs,audio}], duration? }
 *   create(opts) -> task   // opts: {url, headers, saveDir, saveName, select, key, liveRecordLimitMin, mux, referer, userAgent}
 *   listTasks() -> task[]  // unified task objects (engine:'stream')
 *   getTask(id)
 *   pause(id) / resume(id, {restart}) / cancel(id, {deleteFiles}) / pauseAll() / resumeAll()
 *   globalStats() -> { downloadSpeed, numActive }
 * Events: 'progress' (task), 'done' (task), 'error' (task)
 */
export class StreamManager extends EventEmitter {
  constructor(store, settings) {
    super();
    this.store = store;
    this.settings = settings;
    this.native = new NativeStreamEngine(store, settings);
    this.external = hasExternalStreamEngine() ? new ExternalStreamEngine(store, settings) : null;
    for (const e of [this.native, this.external].filter(Boolean)) {
      e.on('progress', (t) => this.emit('progress', t));
      e.on('done', (t) => this.emit('done', t));
      e.on('error', (t) => this.emit('error', t));
    }
  }

  _backend() {
    if (this.external && this.settings.preferExternalStreamEngine) return this.external;
    return this.native;
  }

  probe(url, headers) { return this._backend().probe(url, headers); }

  async create(opts) {
    const backend = this._backend();
    const task = this.store.addStreamTask({
      backend: backend === this.external ? 'external' : 'native',
      status: opts.paused ? 'paused' : 'waiting',
      url: opts.url,
      name: opts.saveName || '',
      saveDir: opts.saveDir,
      options: {
        headers: opts.headers || [],
        select: opts.select || 'best',
        key: opts.key,
        iv: opts.iv,
        drop: opts.drop,
        adKeywords: opts.adKeywords,
        customRange: opts.customRange,
        liveRecordLimitMin: opts.liveRecordLimitMin || 0,
        mux: opts.mux !== false,
        referer: opts.referer,
        userAgent: opts.userAgent,
      },
      progress: { totalSegments: 0, doneSegments: 0, bytesDownloaded: 0, speed: 0, eta: 0, live: false },
      totalLength: 0,
      completedLength: 0,
      downloadSpeed: 0,
      outputFiles: [],
    });
    if (!opts.paused) backend.start(task).catch((err) => {
      this.store.updateStreamTask(task.id, { status: 'error', errorMessage: err.message });
      this.emit('error', this.store.getStreamTask(task.id));
    });
    return task;
  }

  listTasks() {
    return this.store.listStreamTasks().map(t => ({
      id: t.id,
      engine: 'stream',
      kind: 'stream',
      name: t.name || t.url,
      status: t.status,
      totalLength: t.totalLength || 0,
      completedLength: t.completedLength || 0,
      downloadSpeed: t.downloadSpeed || 0,
      progress: t.progress,
      outputFiles: t.outputFiles || [],
      errorMessage: t.errorMessage,
      createdAt: t.createdAt,
      dir: t.saveDir,
      streamMeta: t.streamMeta,
    }));
  }

  getTask(id) { return this.listTasks().find(t => t.id === id); }

  _engineFor(id) {
    const t = this.store.getStreamTask(id);
    if (!t) throw new Error('task not found');
    return t.backend === 'external' && this.external ? this.external : this.native;
  }

  pause(id) { return this._engineFor(id).pause(this.store.getStreamTask(id)); }
  resume(id, opts) { return this._engineFor(id).resume(this.store.getStreamTask(id), opts); }
  cancel(id, opts) { return this._engineFor(id).cancel(this.store.getStreamTask(id), opts); }

  async pauseAll() {
    for (const t of this.store.listStreamTasks()) {
      if (['downloading', 'waiting', 'muxing'].includes(t.status)) await this.pause(t.id).catch(() => {});
    }
  }
  async resumeAll() {
    for (const t of this.store.listStreamTasks()) {
      if (t.status === 'paused') await this.resume(t.id).catch(() => {});
    }
  }

  globalStats() {
    const active = this.store.listStreamTasks().filter(t => ['downloading', 'muxing'].includes(t.status));
    return {
      numActive: active.length,
      downloadSpeed: active.reduce((s, t) => s + (t.downloadSpeed || 0), 0),
    };
  }

  async shutdown() {
    await this.native.shutdownAll?.();
    await this.external?.shutdownAll?.();
  }
}
