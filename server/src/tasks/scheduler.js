/**
 * 定时任务调度器（N_m3u8DL-RE --task-start-at 语义）：
 * 任务以 paused/waiting 状态创建，到达 startAt 后自动启动。
 * 持久化在 TaskStore.meta 中，重启后恢复调度。
 */
export class TaskScheduler {
  constructor(rpc, stream, store) {
    this.rpc = rpc;
    this.stream = stream;
    this.store = store;
    this.timer = null;
    this.starting = new Set();
  }

  /** Restore persisted schedules only after engines are ready. */
  start() {
    this._ensureTimer();
    return this._tick();
  }

  /** 登记一个定时任务。engine: 'aria2'|'stream' */
  schedule(engine, id, startAt) {
    const ts = typeof startAt === 'number' ? startAt : Date.parse(startAt);
    if (!Number.isFinite(ts)) throw new Error('invalid startAt');
    this.store.setMeta(id, { scheduledRevision: (this.store.getMeta(id)?.scheduledRevision || 0) + 1, scheduledAt: ts, scheduledRetryAt: 0, scheduledAttempts: 0, scheduledError: '', engine });
    this._ensureTimer();
    return ts;
  }

  cancel(id) {
    const meta = this.store.getMeta(id);
    if (!meta) return;
    for (const key of ['scheduledAt', 'scheduledRetryAt', 'scheduledAttempts', 'scheduledError']) delete meta[key];
    this.store.setMeta(id, meta);
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick().catch(() => {}), 15000);
    this.timer.unref?.();
  }

  async _tick() {
    const now = Date.now();
    const due = Object.entries(this.store.db.meta).filter(([id, meta]) =>
      Number.isFinite(meta?.scheduledAt) && meta.scheduledAt <= now &&
      !(meta.scheduledRetryAt > now) && !this.starting.has(id));
    // A stream resume may resolve only when recording completes. Do not let
    // one long-running job block other scheduled tasks or later ticks.
    await Promise.all(due.map(async ([id, meta]) => {
      this.starting.add(id);
      const { scheduledAt, scheduledRevision } = meta;
      const isCurrent = (current) => current?.scheduledAt === scheduledAt &&
        current?.scheduledRevision === scheduledRevision;
      try {
        if (meta.engine === 'stream') await this.stream.resume(id);
        else await this.rpc.unpause(id);
        const current = this.store.getMeta(id);
        if (isCurrent(current)) this.cancel(id);
        console.log(`[scheduler] started scheduled task ${id}`);
      } catch (e) {
        const current = this.store.getMeta(id);
        if (!isCurrent(current)) return;
        const attempts = (current.scheduledAttempts || 0) + 1;
        this.store.setMeta(id, {
          scheduledAttempts: attempts,
          scheduledRetryAt: Date.now() + Math.min(60000, 15000 * 2 ** Math.min(attempts - 1, 3)),
          scheduledError: String(e?.message || e),
        });
        console.log(`[scheduler] start ${id} failed; retry scheduled`);
      } finally { this.starting.delete(id); }
    }));
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
