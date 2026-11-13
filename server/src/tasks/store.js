import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from '../config.js';
import { genId } from '../util/helpers.js';
import { writeJsonAtomic } from '../util/atomic-json.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');

/**
 * Persistent store for stream-engine tasks and task metadata.
 * aria2 tasks live inside aria2 itself (session file); we only persist
 * stream tasks plus per-task extras keyed by engine id.
 */
export class TaskStore extends EventEmitter {
  constructor() {
    super();
    this.db = { streamTasks: [], meta: {} };
    this._load();
    this._saveTimer = null;
    this._writing = null;
    this._dirty = false;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      this.db = { streamTasks: [], meta: {}, ...raw };
      // tasks that were active when the app quit become 'paused' (resumable)
      for (const t of this.db.streamTasks) {
        if (['downloading', 'muxing', 'waiting'].includes(t.status)) t.status = 'paused';
      }
    } catch {}
  }

  save() {
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.flush().catch(error => console.error('[store] failed to save tasks:', error.message));
    }, 300);
  }

  async flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    while (this._writing) await this._writing;
    if (!this._dirty) return;
    this._dirty = false;
    this._writing = writeJsonAtomic(DB_FILE, this.db);
    try { await this._writing; }
    catch (error) { this._dirty = true; throw error; }
    finally { this._writing = null; }
    if (this._dirty) await this.flush();
  }

  addStreamTask(fields) {
    const task = {
      id: genId(),
      engine: 'stream',
      status: 'waiting',       // waiting|downloading|paused|muxing|complete|error|cancelled
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields,
    };
    this.db.streamTasks.unshift(task);
    this.save();
    this.emit('changed', 'stream');
    return task;
  }

  getStreamTask(id) { return this.db.streamTasks.find(t => t.id === id); }

  updateStreamTask(id, patch) {
    const t = this.getStreamTask(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.save();
    return t;
  }

  removeStreamTask(id) {
    const i = this.db.streamTasks.findIndex(t => t.id === id);
    if (i >= 0) { this.db.streamTasks.splice(i, 1); this.save(); }
  }

  listStreamTasks() { return this.db.streamTasks; }

  setMeta(gid, meta) { this.db.meta[gid] = { ...(this.db.meta[gid] || {}), ...meta }; this.save(); }
  getMeta(gid) { return this.db.meta[gid]; }
  findDownloads(key) {
    return Object.keys(this.db.meta).filter(id => this.db.meta[id]?.downloadKey === key);
  }
  removeMeta(gid) { delete this.db.meta[gid]; this.save(); }
}
