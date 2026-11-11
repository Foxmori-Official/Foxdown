import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundFixture, waitFor } from '../helpers/extension-background.mjs';
const entry = (patch = {}) => ({ url: 'https://example.invalid/file.zip', itemId: 7, filename: 'file.zip', ts: Date.now(), ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('closing confirmation window resumes browser download and clears persisted entry', async () => {
  const b = backgroundFixture();
  const token = await b.addPendingConfirm(entry({ windowId: 100 }));
  b.listeners.windowRemoved(100);
  await waitFor(() => !b.pendingConfirms.has(token));
  assert.deepEqual(b.calls.resume, [7]);
  assert.equal(b.session['kimi-pending-' + token], undefined);
  assert.equal(b.calls.fetch.length, 0);
});

test('expiry and malformed timestamps resume once, including alarm cleanup', async () => {
  const b = backgroundFixture();
  const expired = await b.addPendingConfirm(entry());
  b.pendingConfirms.get(expired).ts = Date.now() - 600001;
  assert.equal(await b.getPendingConfirm(expired), null);
  const invalid = await b.addPendingConfirm(entry({ itemId: 8 }));
  b.pendingConfirms.get(invalid).ts = undefined;
  b.listeners.alarm({ name: 'rdown-pending-cleanup' });
  await waitFor(() => !b.pendingConfirms.has(invalid));
  await b.sweepPendingConfirms();
  assert.deepEqual(b.calls.resume, [7, 8]);
});

test('worker startup restores active dialogs and releases missing / expired windows', async () => {
  const b = backgroundFixture({
    persisted: {
      'kimi-pending-live': entry({ windowId: 11 }),
      'kimi-pending-gone': entry({ itemId: 8, windowId: 12 }),
      'kimi-pending-old': entry({ itemId: 9, ts: Date.now() - 600001 }),
      'unrelated-storage': { value: 'keep' },
    }, missingWindows: [12],
  });
  await b.pendingRestore;
  assert.equal(b.pendingConfirms.size, 1);
  assert.ok(b.pendingConfirms.has('live'));
  assert.deepEqual(b.calls.resume, [8, 9]);
  assert.deepEqual(b.session['unrelated-storage'], { value: 'keep' });
});

test('confirm and immediate window close are serialized: successful handoff never resumes browser', async () => {
  const b = backgroundFixture();
  const token = await b.addPendingConfirm(entry({ windowId: 100 }));
  const response = deferred();
  b.controls.post = () => response.promise;
  const confirmed = b.confirmPendingDownload(token);
  await waitFor(() => b.calls.fetch.length === 1);
  b.listeners.windowRemoved(100);
  response.resolve({ ok: true, json: async () => ({ id: 'fake-task' }) });
  await confirmed;
  await b.cancelPendingDownload(token);
  assert.equal(b.calls.fetch.length, 1);
  assert.deepEqual(b.calls.cancel, [7]);
  assert.deepEqual(b.calls.erase, [7]);
  assert.deepEqual(b.calls.resume, []);
});

test('failed handoff then close recovers original download; concurrent confirm submits only once', async () => {
  const b = backgroundFixture();
  const token = await b.addPendingConfirm(entry({ windowId: 100 }));
  const response = deferred();
  b.controls.post = () => response.promise;
  const failed = assert.rejects(b.confirmPendingDownload(token), /offline/);
  await waitFor(() => b.calls.fetch.length === 1);
  const cancelled = b.cancelPendingDownload(token);
  response.reject(new Error('offline'));
  await failed; await cancelled;
  assert.deepEqual(b.calls.resume, [7]);
  assert.equal(b.pendingConfirms.has(token), false);

  b.controls.post = async () => ({ ok: true, json: async () => ({ id: 'fake-task' }) });
  const next = await b.addPendingConfirm(entry({ itemId: 8 }));
  const results = await Promise.all([b.confirmPendingDownload(next), b.confirmPendingDownload(next)]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].error, 'expired');
  assert.equal(b.calls.fetch.length, 2);
});

test('temporary resume failure stays persisted and is retried by cleanup', async () => {
  const b = backgroundFixture();
  const token = await b.addPendingConfirm(entry());
  const resume = b.chrome.downloads.resume;
  b.chrome.downloads.resume = async () => { throw new Error('Chrome busy'); };
  await b.cancelPendingDownload(token);
  assert.equal(b.pendingConfirms.get(token).releaseRequested, true);
  assert.equal(b.session['kimi-pending-' + token].releaseRequested, true);
  b.chrome.downloads.resume = resume;
  await b.sweepPendingConfirms();
  assert.deepEqual(b.calls.resume, [7]);
  assert.equal(b.pendingConfirms.has(token), false);
});

test('navigation and tab close clear only that tab media and in-flight sniff headers', async () => {
  const b = backgroundFixture();
  await b.pendingRestore;
  b.addDeepSearchMedia(1, ['https://example.invalid/one.mp4'], 'https://example.invalid/page');
  b.addDeepSearchMedia(2, ['https://example.invalid/two.mp4'], 'https://example.invalid/page');
  b.sniffHeaderMap.set('one', { tabId: 1 });
  b.sniffHeaderMap.set('two', { tabId: 2 });
  b.listeners.tabUpdated(1, { status: 'loading' });
  assert.equal(b.sniffedMedia.has(1), false);
  assert.equal(b.sniffHeaderMap.has('one'), false);
  assert.equal(b.sniffedMedia.has(2), true);
  b.listeners.tabRemoved(2);
  assert.equal(b.sniffedMedia.size, 0);
  assert.equal(b.sniffHeaderMap.size, 0);
});

test('event socket authenticates, reconnects on configuration change and closes when disabled', async () => {
  const b = backgroundFixture();
  b.sync.servers = [{ url: 'http://127.0.0.1:16801', token: 'test token+&', pattern: '*' }];
  b.sync.notifyComplete = true;
  await b.connectEvents();
  let socket = b.calls.sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('token'), 'test token+&');
  b.sync.servers[0].token = 'new-test-token';
  await b.connectEvents();
  assert.equal(socket.closed, true);
  socket = b.calls.sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('token'), 'new-test-token');
  b.sync.notifyComplete = false;
  await b.connectEvents();
  assert.equal(socket.closed, true);
  assert.equal(socket.onclose, null);
});

test('confirmation window closed immediately during creation cannot orphan paused browser download', async () => {
  const b = backgroundFixture({ missingWindows: [100] });
  b.listeners.download({ id: 42, url: 'https://example.invalid/file.zip', filename: 'file.zip', fileSize: 1024 });
  await waitFor(() => b.calls.resume.includes(42));
  assert.equal(b.calls.windows.length, 1);
  assert.equal(b.pendingConfirms.size, 0);
  assert.equal(b.calls.fetch.length, 0);
});

test('hung POST headers or body have a 15s deadline; queued X-close and expiry recover only once', async () => {
  for (const stall of ['headers', 'body']) {
    const b = backgroundFixture();
    const token = await b.addPendingConfirm(entry({ windowId: 100 }));
    let pendingRead = false;
    b.controls.post = (_url, { signal }) => {
      const waitUntilAborted = () => new Promise((_resolve, reject) => {
        pendingRead = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return stall === 'headers' ? waitUntilAborted() : Promise.resolve({ ok: true, json: waitUntilAborted });
    };
    const confirmed = assert.rejects(b.confirmPendingDownload(token), /test-only request timeout/);
    await waitFor(() => pendingRead);
    assert.equal(b.controls.timeouts.length, 1);
    assert.equal(b.controls.timeouts[0].milliseconds, 15000);
    b.pendingConfirms.get(token).ts = Date.now() - 600001;
    const sweep = b.sweepPendingConfirms();
    b.listeners.windowRemoved(100);
    assert.deepEqual(b.calls.resume, [], 'do not resume while a POST could still commit');
    b.controls.timeouts[0].controller.abort(new Error('test-only request timeout'));
    await confirmed; await sweep; await b.cancelPendingDownload(token);
    assert.deepEqual(b.calls.resume, [7], `${stall}: expire + X-close must not double-resume`);
    assert.deepEqual(b.calls.cancel, []);
    assert.equal(b.pendingConfirms.size, 0);
  }
});

test('a deadline firing after successful POST cannot undo committed handoff', async () => {
  const b = backgroundFixture();
  const token = await b.addPendingConfirm(entry({ windowId: 100 }));
  const confirmed = await b.confirmPendingDownload(token);
  assert.equal(confirmed.ok, true);
  b.controls.timeouts[0].controller.abort(new Error('late timeout'));
  b.listeners.windowRemoved(100);
  await b.sweepPendingConfirms();
  await b.cancelPendingDownload(token);
  assert.deepEqual(b.calls.cancel, [7]);
  assert.deepEqual(b.calls.resume, []);
  assert.equal(b.calls.fetch.length, 1);
});

test('cleanup alarms preserve the Chrome 116-compatible one-minute period', () => {
  const b = backgroundFixture();
  const cleanup = b.calls.alarms.find(alarm => alarm.name === 'rdown-pending-cleanup');
  assert.equal(cleanup.periodInMinutes, 1);
});
