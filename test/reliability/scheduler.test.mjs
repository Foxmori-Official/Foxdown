import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler } from '../../server/src/tasks/scheduler.js';

function fixture(meta = {}) {
  const store = {
    db: { meta: structuredClone(meta) },
    getMeta(id) { return this.db.meta[id]; },
    // Deliberately match TaskStore's MERGE semantics (deleting a copied field
    // would not persist). Tests must not hide that subtlety.
    setMeta(id, patch) { this.db.meta[id] = { ...this.db.meta[id], ...patch }; },
  };
  const calls = [];
  const scheduler = new TaskScheduler({ unpause: async id => calls.push(id) }, { resume: async id => calls.push(id) }, store);
  return { store, calls, scheduler };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('start restores overdue schedules and leaves future jobs paused; repeat start does not duplicate', async t => {
  const { scheduler, store, calls } = fixture({ overdue: { scheduledAt: 0, engine: 'stream', name: 'keep' }, future: { scheduledAt: Date.now() + 60000 } });
  t.after(() => scheduler.stop());
  await scheduler.start();
  const timer = scheduler.timer;
  await scheduler.start();
  assert.equal(scheduler.timer, timer);
  assert.deepEqual(calls, ['overdue']);
  assert.equal(store.getMeta('overdue').scheduledAt, undefined);
  assert.equal(store.getMeta('overdue').name, 'keep');
  assert.ok(store.getMeta('future').scheduledAt);
});

test('failed startup is persisted, backs off, retries, then clears all retry fields', async t => {
  const { scheduler, store } = fixture({ job: { scheduledAt: 0, engine: 'aria2' } });
  t.after(() => scheduler.stop());
  let attempts = 0;
  scheduler.rpc.unpause = async () => { if (++attempts < 2) throw new Error('engine restarting'); };
  await scheduler._tick();
  assert.equal(store.getMeta('job').scheduledAttempts, 1);
  assert.equal(store.getMeta('job').scheduledAt, 0);
  assert.equal(store.getMeta('job').scheduledError, 'engine restarting');
  assert.ok(store.getMeta('job').scheduledRetryAt > Date.now());
  await scheduler._tick();
  assert.equal(attempts, 1);
  store.setMeta('job', { scheduledRetryAt: 0 });
  await scheduler._tick();
  assert.equal(attempts, 2);
  for (const field of ['scheduledAt', 'scheduledError', 'scheduledAttempts', 'scheduledRetryAt']) assert.equal(store.getMeta('job')[field], undefined);
});

test('long-running stream neither blocks other jobs nor starts twice on overlapping ticks', async () => {
  const { scheduler, store, calls } = fixture({ live: { scheduledAt: 0, engine: 'stream' }, file: { scheduledAt: 0 } });
  const pending = deferred();
  scheduler.stream.resume = id => { calls.push(id); return pending.promise; };
  const firstTick = scheduler._tick();
  assert.deepEqual(calls, ['live', 'file']);
  store.setMeta('later', { scheduledAt: 0 });
  await scheduler._tick();
  assert.deepEqual(calls, ['live', 'file', 'later']);
  pending.resolve();
  await firstTick;
  assert.equal(scheduler.starting.size, 0);
});

test('cancel during startup prevents stale error from restoring schedule', async () => {
  const { scheduler, store } = fixture({ job: { scheduledAt: 0 } });
  const pending = deferred();
  scheduler.rpc.unpause = () => pending.promise;
  const tick = scheduler._tick();
  scheduler.cancel('job');
  pending.reject(new Error('offline'));
  await tick;
  assert.equal(store.getMeta('job').scheduledAt, undefined);
  assert.equal(store.getMeta('job').scheduledRetryAt, undefined);
});

test('rescheduling same timestamp during startup preserves the new revision', async t => {
  const { scheduler, store } = fixture({ job: { scheduledAt: 0 } });
  t.after(() => scheduler.stop());
  const pending = deferred();
  scheduler.rpc.unpause = () => pending.promise;
  const tick = scheduler._tick();
  scheduler.schedule('aria2', 'job', 0);
  pending.resolve();
  await tick;
  assert.equal(store.getMeta('job').scheduledAt, 0);
  scheduler.rpc.unpause = async () => {};
  await scheduler._tick();
  assert.equal(store.getMeta('job').scheduledAt, undefined);
});

test('invalid schedule timestamps cannot arm timers', () => {
  const { scheduler } = fixture();
  for (const value of ['bad-date', NaN, Infinity]) assert.throws(() => scheduler.schedule('aria2', 'job', value), /invalid startAt/);
  assert.equal(scheduler.timer, null);
});

test('repeated startup failures keep bounded exponential backoff and cancel clears retry state', async () => {
  const { scheduler, store } = fixture({ job: { scheduledAt: 0 } });
  scheduler.rpc.unpause = async () => { throw new Error('still offline'); };
  for (let attempt = 1; attempt <= 7; attempt++) {
    store.setMeta('job', { scheduledRetryAt: 0 });
    const before = Date.now();
    await scheduler._tick();
    const after = Date.now();
    const expected = Math.min(60000, 15000 * 2 ** Math.min(attempt - 1, 3));
    const saved = store.getMeta('job');
    assert.equal(saved.scheduledAttempts, attempt);
    assert.ok(saved.scheduledRetryAt >= before + expected && saved.scheduledRetryAt <= after + expected);
  }
  scheduler.cancel('job');
  assert.equal(store.getMeta('job').scheduledAt, undefined);
  assert.equal(store.getMeta('job').scheduledRetryAt, undefined);
  assert.equal(store.getMeta('job').scheduledAttempts, undefined);
  assert.equal(store.getMeta('job').scheduledError, undefined);
});
