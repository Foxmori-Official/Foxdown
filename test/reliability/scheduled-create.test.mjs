import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskFromBody } from '../../server/src/tasks/create.js';
import { isolateServer } from '../helpers/server-fixture.mjs';

test('scheduled stream creation is paused from birth, without starting network work', async t => {
  isolateServer(t);
  const { StreamManager } = await import('../../server/src/stream/index.js');
  const tasks = [];
  const store = {
    addStreamTask(fields) { const task = { id: 'scheduled-stream', ...fields }; tasks.push(task); return task; },
  };
  const stream = new StreamManager(store, {});
  let started = 0;
  stream.native.start = async () => { started++; };
  const scheduled = [];
  const api = { stream, settings: {}, scheduler: { schedule: (...args) => scheduled.push(args) } };
  const result = await createTaskFromBody(api, { url: 'https://example.invalid/media.m3u8', options: { startAt: 0 } });
  assert.equal(result.engine, 'stream');
  assert.equal(tasks[0].status, 'paused');
  assert.equal(started, 0);
  assert.deepEqual(scheduled, [['stream', 'scheduled-stream', 0]]);
  await stream.create({ url: 'https://example.invalid/now.m3u8' });
  assert.equal(started, 1, 'non-scheduled creation still starts normally');
});

test('invalid startAt is rejected before any RPC or stream creation', async () => {
  let effects = 0;
  const api = {
    scheduler: {}, settings: {},
    rpc: { addUri: () => { effects++; } }, stream: { create: () => { effects++; } },
  };
  for (const url of ['https://example.invalid/file.zip', 'https://example.invalid/media.m3u8']) {
    await assert.rejects(createTaskFromBody(api, { url, options: { startAt: 'not a date' } }), /invalid startAt/);
  }
  assert.equal(effects, 0);
});

test('scheduled file is created paused and uses normalized timestamp including epoch zero', async () => {
  const calls = [];
  const api = {
    settings: {}, scheduler: { schedule: (...args) => calls.push(['schedule', ...args]) },
    rpc: { addUri: async (urls, options) => { calls.push(['rpc', urls, options]); return 'gid'; } },
    store: { setMeta: () => {} },
  };
  await createTaskFromBody(api, { url: 'https://example.invalid/file.zip', options: { startAt: 0 } });
  assert.equal(calls[0][2].pause, 'true');
  assert.deepEqual(calls[1], ['schedule', 'aria2', 'gid', 0]);
});
