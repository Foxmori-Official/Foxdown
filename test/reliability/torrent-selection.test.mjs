import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createTaskFromBody } from '../../server/src/tasks/create.js';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { parse } = require('@vue/compiler-sfc');
const { parse: parseJs } = require('@babel/parser');
const { ref, computed, nextTick, watch } = require('vue');
function dialog(resolve = async () => ({ type: 'file' }), create = async () => {}) {
  const { descriptor } = parse(fs.readFileSync(new URL('../../web/src/components/NewTaskDialog.vue', import.meta.url), 'utf8'));
  let script = descriptor.scriptSetup.content;
  const imports = parseJs(script, { sourceType: 'module' }).program.body.filter(n => n.type === 'ImportDeclaration');
  for (const node of imports.reverse()) script = script.slice(0, node.start) + script.slice(node.end);
  const calls = [], warnings = [], successes = [], visibility = [];
  const state = vm.runInNewContext(`(()=>{${script};return {urlsText,resolved,torrentSelected,torrentBase64,canSubmit,submit,doResolve,batchResult,failureReason}})()`, {
    ref, computed, nextTick, watch, defineProps: () => ({}), defineEmits: () => (_event, value) => visibility.push(value),
    useI18n: () => ({ t: key => key }), api: { resolve, createTask: async payload => { calls.push(payload); return create(payload); } },
    ElMessage: { warning: message => warnings.push(message), success: message => successes.push(message), error(error) { throw new Error(error); } },
  });
  const files = [{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }];
  state.urlsText.value = 'https://example.invalid/test.torrent';
  state.resolved.value = { type: 'torrent', files };
  return { state, calls, warnings, successes, visibility };
}
test('empty resolved torrent selection disables submit and cannot create a task through the handler', async () => {
  const { state, calls, warnings } = dialog();
  assert.equal(state.canSubmit.value, false);
  await state.submit();
  assert.equal(calls.length, 0);
  assert.deepEqual(warnings, ['dialog.selectAtLeastOneFile']);
});
test('a partial selection forwards exact one-based indices, and selecting all permits download', async () => {
  const { state, calls } = dialog();
  state.torrentSelected.value = [state.resolved.value.files[0], state.resolved.value.files[2]];
  assert.equal(state.canSubmit.value, true); await state.submit();
  assert.equal(calls[0].options.selectFile, '1,3');
  state.torrentSelected.value = [...state.resolved.value.files];
  await state.submit(); assert.equal(calls.length, 2); assert.equal(calls[1].options.selectFile, undefined);
});
test('unresolved magnets, plain URLs and torrent uploads still allow creation', async () => {
  const { state, calls } = dialog(); state.resolved.value = { type: 'torrent', files: [] };
  assert.equal(state.canSubmit.value, true); await state.submit();
  state.torrentBase64.value = 'SYNTHETIC_FIXTURE'; state.resolved.value.files = [{ path: 'file' }];
  assert.equal(state.canSubmit.value, true); await state.submit(); assert.equal(calls[1].torrentBase64, 'SYNTHETIC_FIXTURE');
  state.torrentBase64.value = ''; state.resolved.value = { type: 'file' };
  assert.equal(state.canSubmit.value, true); await state.submit(); assert.equal(calls.length, 3);
});
test('explicit invalid API selections are rejected before any engine is called', async () => {
  for (const selectFile of ['', ' ', 0, '0', null, [], '1,', '3-1', '1-0', '-1', '1,0', '999999999999999999999']) {
    await assert.rejects(createTaskFromBody({}, { url: 'magnet:?xt=urn:btih:FIXTURE', options: { selectFile } }), /invalid selectFile/);
  }
});
test('valid API selection reaches aria2 unchanged and an omitted selection remains compatible', async () => {
  const calls = [];
  const api = { rpc: { addUri: async (_urls, options) => { calls.push(options); return 'fake-gid'; } }, store: { setMeta() {} } };
  await createTaskFromBody(api, { url: 'magnet:?xt=urn:btih:FIXTURE', options: { selectFile: '1,3-5' } });
  assert.equal(calls[0]['select-file'], '1,3-5');
  await createTaskFromBody(api, { url: 'magnet:?xt=urn:btih:FIXTURE' });
  assert.equal(calls[1]['select-file'], undefined);
});


test('editing the URL clears old file selections and unblocks a different URL', () => {
  const { state } = dialog(); assert.equal(state.canSubmit.value, false);
  state.urlsText.value = 'https://example.invalid/another.zip';
  assert.equal(state.resolved.value, null); assert.equal(state.torrentSelected.value.length, 0);
  assert.equal(state.canSubmit.value, true);
});
test('a late resolve result cannot attach an old torrent list to the edited URL', async () => {
  let finish;
  const { state } = dialog(() => new Promise(resolve => { finish = resolve; }));
  const pending = state.doResolve();
  state.urlsText.value = 'https://example.invalid/another.zip';
  finish({ type: 'torrent', files: [{ path: 'old-file' }] }); await pending;
  assert.equal(state.resolved.value, null); assert.equal(state.canSubmit.value, true);
});

test('a partial batch retains only the rejected links and can retry the remaining single link', async () => {
  const first = 'https://example.invalid/first.zip';
  const second = 'https://example.invalid/second.zip';
  let fail = true;
  const { state, calls, successes, visibility } = dialog(undefined, async ({ url }) => {
    if (fail && url === second) throw Object.assign(new Error('Invalid link'), { status: 400 });
  });
  state.urlsText.value = first + '\n' + second;
  await state.submit();
  assert.equal(state.urlsText.value, second);
  assert.equal(state.batchResult.value.created, 1);
  assert.equal(state.failureReason(state.batchResult.value.failures[0].error), 'Invalid link');
  assert.deepEqual(successes, []);
  assert.deepEqual(visibility, []);
  fail = false;
  await state.submit();
  assert.deepEqual(calls.map(({ url }) => url), [first, second, second]);
  assert.deepEqual(successes, ['dialog.created']);
  assert.deepEqual(visibility, [false]);
});

test('a failed batch stays open with every unresolved link, and a concurrent submit does not repeat requests', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { state, calls, successes, visibility } = dialog(undefined, async () => {
    await gate;
    throw new Error('network request failed');
  });
  const urls = 'https://example.invalid/a.zip\nhttps://example.invalid/b.zip';
  state.urlsText.value = urls;
  const pending = state.submit();
  await state.submit();
  assert.equal(calls.length, 1);
  release();
  await pending;
  assert.equal(calls.length, 2);
  assert.equal(state.urlsText.value, urls);
  assert.equal(state.batchResult.value.created, 0);
  assert.equal(state.batchResult.value.failures.length, 2);
  assert.equal(state.failureReason(state.batchResult.value.failures[0].error), 'dialog.creationUnconfirmed');
  assert.deepEqual(successes, []);
  assert.deepEqual(visibility, []);
});
