import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NM3U8_BIN } from '../config.js';

/**
 * External stream engine: drives N_m3u8DL-RE.exe when the user drops it into bin/.
 * Parses its console progress lines: "Vid 1080p | 12.34% | 123/1000 | 1.23MBps ..."
 * Falls back gracefully - the native engine is used when this binary is absent.
 */
export class ExternalStreamEngine extends EventEmitter {
  constructor(store, settings) {
    super();
    this.store = store;
    this.settings = settings;
    this.running = new Map(); // id -> proc
  }

  async probe(url, headers) {
    // N_m3u8DL-RE has no probe mode; use the native parser for probing.
    const { probeStream } = await import('./probe-native.js');
    return probeStream(url, headers);
  }

  async start(task) {
    const o = task.options || {};
    this.store.updateStreamTask(task.id, { status: 'downloading' });
    const args = [
      task.url,
      '--save-dir', task.saveDir,
      '--thread-count', String(this.settings.streamThreadCount || 8),
      '--download-retry-count', String(this.settings.streamRetryCount || 5),
      '--http-request-timeout', String(Math.round((this.settings.streamTimeoutMs || 20000) / 1000)),
      '--auto-select',
      '--no-log',
      '--ui-language', 'zh-CN',
    ];
    if (task.name) args.push('--save-name', task.name.replace(/\.[^.]+$/, ''));
    if (o.key) args.push('--key', o.key);
    if (o.select && o.select !== 'best') args.push('-sv', o.select);
    if (o.liveRecordLimitMin) args.push('--live-record-limit', `00:${String(o.liveRecordLimitMin).padStart(2, '0')}:00`);
    for (const h of o.headers || []) args.push('-H', h);
    if (o.referer) args.push('-H', `Referer: ${o.referer}`);
    if (o.userAgent) args.push('-H', `User-Agent: ${o.userAgent}`);
    if (o.mux === false) args.push('--skip-merge');

    const proc = spawn(NM3U8_BIN, args, { windowsHide: true });
    this.running.set(task.id, proc);
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) this._parseLine(task.id, line);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      this.running.delete(task.id);
      const t = this.store.getStreamTask(task.id);
      if (!t) return;
      if (t.status === 'cancelled' || t.status === 'paused') return;
      if (code === 0) {
        this.store.updateStreamTask(task.id, { status: 'complete', downloadSpeed: 0 });
        this.emit('done', this.store.getStreamTask(task.id));
      } else {
        this.store.updateStreamTask(task.id, { status: 'error', errorMessage: `N_m3u8DL-RE exited ${code}`, downloadSpeed: 0 });
        this.emit('error', this.store.getStreamTask(task.id));
      }
    });
    this.emit('progress', this.store.getStreamTask(task.id));
  }

  _parseLine(id, line) {
    // e.g. "Vid 1920x1080 |  45.6% | 456/1000 | 2.35MBps | 00:01:23"
    const m = /(\d+(?:\.\d+)?)%\s*\|\s*(\d+)\/(\d+)\s*\|\s*([\d.]+)\s*(KB|MB|GB|B)ps/i.exec(line);
    if (!m) return;
    const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[4].toUpperCase()] || 1;
    const done = Number(m[2]), total = Number(m[3]);
    const speed = Number(m[1 + 3]) * unit;
    const t = this.store.getStreamTask(id);
    if (!t) return;
    const prev = t.progress || {};
    this.store.updateStreamTask(id, {
      downloadSpeed: speed,
      progress: { ...prev, doneSegments: done, totalSegments: total, speed },
    });
    this.emit('progress', this.store.getStreamTask(id));
  }

  async pause(task) {
    const p = this.running.get(task.id);
    if (p) { try { p.kill(); } catch {} this.running.delete(task.id); }
    this.store.updateStreamTask(task.id, { status: 'paused', downloadSpeed: 0 });
  }

  async resume(task) {
    if (this.running.has(task.id)) return;
    await this.start(task); // N_m3u8DL-RE resumes from its own cache dir
  }

  async cancel(task, { deleteFiles } = {}) {
    const p = this.running.get(task.id);
    if (p) { try { p.kill(); } catch {} this.running.delete(task.id); }
    this.store.updateStreamTask(task.id, { status: 'cancelled', downloadSpeed: 0 });
    if (deleteFiles) for (const f of task.outputFiles || []) { try { fs.unlinkSync(f); } catch {} }
    this.store.removeStreamTask(task.id);
  }

  async shutdownAll() {
    for (const p of this.running.values()) { try { p.kill(); } catch {} }
    this.running.clear();
  }
}
