import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolateServer } from '../helpers/server-fixture.mjs';
import { TaskScheduler } from '../../server/src/tasks/scheduler.js';

test('real TaskStore reload preserves failed schedules and persists successful cleanup', async t => {
  const root = isolateServer(t);
  const data = path.join(root, 'DATA_DIR');
  fs.mkdirSync(data);
  const file = path.join(data, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ streamTasks: [], meta: { restored: { scheduledAt: 0, engine: 'aria2', name: 'keep' } } }));
  const { TaskStore } = await import('../../server/src/tasks/store.js');
  const store = new TaskStore();
  let fail = true;
  const scheduler = new TaskScheduler({ unpause: async () => { if (fail) throw new Error('isolated engine offline'); } }, {}, store);
  async function waitPersisted(predicate) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const saved = JSON.parse(await fs.promises.readFile(file, 'utf8')).meta.restored;
      if (predicate(saved)) return;
      assert.ok(Date.now() < deadline, 'scheduled state must be persisted by the automatic save');
      await delay(20);
    }
  }
  try {
    await scheduler.start();
    await waitPersisted(meta => meta.scheduledAttempts === 1);
    const reloaded = new TaskStore();
    assert.equal(reloaded.getMeta('restored').scheduledAt, 0);
    assert.equal(reloaded.getMeta('restored').scheduledAttempts, 1);
    assert.ok(reloaded.getMeta('restored').scheduledRetryAt > Date.now());
    fail = false;
    store.setMeta('restored', { scheduledRetryAt: 0 });
    await scheduler._tick();
    await waitPersisted(meta => meta.scheduledAt === undefined);
    const completed = new TaskStore().getMeta('restored');
    assert.equal(completed.scheduledAt, undefined);
    assert.equal(completed.scheduledAttempts, undefined);
    assert.equal(completed.name, 'keep');
  } finally {
    scheduler.stop();
    await store.flush();
  }
});
