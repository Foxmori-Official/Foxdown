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
  await waitFor(() => !b.sniffedMedia.has(1));
  assert.equal(b.sniffedMedia.has(1), false);
  assert.equal(b.sniffHeaderMap.has('one'), false);
  assert.equal(b.sniffedMedia.has(2), true);
  b.listeners.tabRemoved(2);
  await waitFor(() => b.sniffedMedia.size === 0);
  assert.equal(b.sniffedMedia.size, 0);
  assert.equal(b.sniffHeaderMap.size, 0);
});

test('event socket authenticates and stays connected for badges when notifications are disabled', async () => {
  const b = backgroundFixture();
  b.local.servers = [{ url: 'http://127.0.0.1:16801', token: 'test token+&', pattern: '*' }];
  b.local.notifyComplete = true;
  await b.connectEvents();
  let socket = b.calls.sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('token'), 'test token+&');
  b.local.servers[0].token = 'new-test-token';
  await b.connectEvents();
  assert.equal(socket.closed, true);
  socket = b.calls.sockets.at(-1);
  assert.equal(new URL(socket.url).searchParams.get('token'), 'new-test-token');
  b.local.notifyComplete = false;
  await b.connectEvents();
  assert.equal(socket.closed, true);
  assert.equal(socket.onclose, null);
  assert.equal(b.calls.sockets.at(-1).closed, false);
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
    const deadline = b.controls.timeouts.find(timeout => timeout.milliseconds === 15000);
    assert.ok(deadline);
    b.pendingConfirms.get(token).ts = Date.now() - 600001;
    const sweep = b.sweepPendingConfirms();
    b.listeners.windowRemoved(100);
    assert.deepEqual(b.calls.resume, [], 'do not resume while a POST could still commit');
    deadline.controller.abort(new Error('test-only request timeout'));
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
  b.controls.timeouts.find(timeout => timeout.milliseconds === 15000).controller.abort(new Error('late timeout'));
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

test('external requests reject web pages and cannot override directories or unsafe filenames', async () => {
  const b = backgroundFixture();
  b.local.allowExternalRequest = true;
  const submit = (message, sender) => new Promise(resolve => b.listeners.externalMessage(message, sender, resolve));
  const payload = { type: 'download', url: 'https://example.invalid/file.zip' };
  assert.match((await submit(payload, { url: 'https://untrusted.example/' })).error, /only other extensions/);
  assert.equal(b.calls.fetch.length, 0);
  for (const name of ['../../startup.sh', '..\\startup.cmd', '/tmp/file', '.profile', 'NUL.txt', 'name:stream']) {
    assert.equal((await submit({ ...payload, filename: name, options: { out: name, dir: '/outside/downloads' } }, { id: 'other-extension' })).ok, true);
    const options = JSON.parse(b.calls.fetch.at(-1)[1].body).options;
    assert.equal(options.dir, undefined);
    assert.equal(options.out, undefined);
  }
  assert.equal((await submit({ ...payload, filename: 'file.zip', options: { split: 4 } }, { id: 'other-extension' })).ok, true);
  assert.equal(JSON.parse(b.calls.fetch.at(-1)[1].body).options.out, 'file.zip');
});

test('batch links require confirmation, restrict submissions to selected links and retain failed items', async () => {
  const b = backgroundFixture();
  b.local.extMode = 'whitelist';
  b.local.extList = 'zip';
  const good = 'https://example.invalid/first.zip';
  const failed = 'https://example.invalid/retry.zip';
  await b.confirmPageLinks([good, good, failed, 'https://example.invalid/page.html', 'javascript:alert(1)'], 'https://example.invalid/page');
  assert.equal(b.calls.fetch.length, 0);
  assert.equal(b.calls.windows.length, 1);
  assert.match(b.calls.windows[0].url, /mode=batch/);
  const token = b.pendingConfirms.keys().next().value;
  b.controls.post = async (_url, request) => {
    if (JSON.parse(request.body).url === failed) throw new Error('offline');
    return { ok: true, json: async () => ({ id: 'fixture-task' }) };
  };
  const result = await b.submitPageLinks(token, [good, failed, 'https://outside.invalid/not-selected.zip']);
  assert.deepEqual([...result.sent], [good]);
  assert.deepEqual([...b.pendingConfirms.get(token).urls], [failed]);
  b.controls.post = async () => ({ ok: true, json: async () => ({ id: 'retry-fixture' }) });
  const retried = await Promise.all([b.submitPageLinks(token, [good, failed]), b.submitPageLinks(token, [failed])]);
  assert.deepEqual([...retried[0].sent], [failed]);
  assert.equal(retried[1].sent.length, 0);
  assert.equal(b.calls.fetch.length, 3);
  await b.cancelPendingDownload(token);
  assert.equal(b.pendingConfirms.size, 0);
  assert.deepEqual(b.calls.resume, []);
});

test('media and successful automatic handoffs survive a worker restart', async () => {
  const first = backgroundFixture();
  await first.mediaRestore;
  first.local.autoDownloadSniffed = true;
  first.local.autoDownloadMinSizeMB = 0;
  const media = { url: 'https://example.invalid/movie.mp4', type: 'MP4', size: 100 };
  first.addDeepSearchMedia(1, [media.url], 'https://example.invalid/page');
  await first.maybeAutoDownload(media);
  assert.equal(first.calls.fetch.length, 1);
  const second = backgroundFixture({ persisted: structuredClone(first.session) });
  await second.mediaRestore;
  second.local.autoDownloadSniffed = true;
  second.local.autoDownloadMinSizeMB = 0;
  assert.equal(second.sniffedMedia.get(1).get(media.url).url, media.url);
  await second.maybeAutoDownload(media);
  assert.equal(second.calls.fetch.length, 0);
  second.listeners.tabRemoved(1);
  await waitFor(() => !second.session['foxdown-media-1']);
});

test('forged deep-search messages cannot insert or automatically send media', async () => {
  const b = backgroundFixture();
  b.local.autoDownloadSniffed = true;
  b.local.autoDownloadMinSizeMB = 0;
  await b.mediaRestore;
  b.listeners.message({ type: 'kimi-deep-search-media', urls: ['https://example.invalid/forged.mp4'] }, { tab: { id: 1 } }, () => {});
  assert.equal(b.sniffedMedia.size, 0);
  b.addDeepSearchMedia(1, ['https://example.invalid/candidate.mp4'], 'https://example.invalid/page');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.fetch.length, 0);
  b.listeners.sniffHeaders({ tabId: 1, requestId: 'fixture-network', requestHeaders: [{ name: 'Referer', value: 'https://example.invalid/page' }] });
  b.listeners.response({ tabId: 1, requestId: 'fixture-network', url: 'https://example.invalid/candidate.mp4', type: 'media', responseHeaders: [{ name: 'Content-Length', value: '100' }] });
  await waitFor(() => b.calls.fetch.length === 1);
  assert.equal(b.sniffedMedia.get(1).get('https://example.invalid/candidate.mp4').source, 'network');
});

test('preview Referer rules are scoped to the extension request and removed on close', async () => {
  const b = backgroundFixture();
  await b.mediaRestore;
  const url = 'https://media.example.invalid/video.mp4?key=a+b';
  b.sniffedMedia.set(1, new Map([[url, { url, source: 'network', type: 'MP4', headers: { referer: 'https://example.invalid/watch' } }]]));
  let receive, disconnect, ready = false;
  const port = {
    name: 'foxdown-media-preview',
    sender: { url: b.chrome.runtime.getURL('popup.html'), tab: { id: 42 } },
    onMessage: { addListener: callback => { receive = callback; } },
    onDisconnect: { addListener: callback => { disconnect = callback; } },
    postMessage: () => { ready = true; },
  };
  b.listeners.connect(port);
  receive({ tabId: 1, url });
  await waitFor(() => ready);
  const rule = b.calls.rules[0].addRules[0];
  const pattern = new RegExp(rule.condition.regexFilter);
  assert.ok(pattern.test(url));
  assert.ok(!pattern.test(url + 'x'));
  assert.ok(!pattern.test(url.replace('media.example', 'mediaXexample')));
  assert.deepEqual([...rule.condition.tabIds], [42]);
  assert.deepEqual([...rule.condition.initiatorDomains], [b.chrome.runtime.id]);
  assert.equal(rule.action.requestHeaders[0].value, 'https://example.invalid/watch');
  disconnect();
  await waitFor(() => b.calls.rules.length === 2);
  assert.deepEqual([...b.calls.rules[1].removeRuleIds], [rule.id]);
});

test('task badges update from push messages, take precedence over resources and clear after recovery', async () => {
  const b = backgroundFixture();
  b.chrome.tabs.query = async () => [{ id: 11 }, { id: 12 }];
  b.local.notifyComplete = false;
  await b.connectEvents();
  await b.refreshBadge();
  const socket = b.calls.sockets.at(-1);
  const push = tasks => socket.onmessage({ data: JSON.stringify({ type: 'state', tasks }) });
  await push([{ id: 'one', status: 'active' }]);
  await waitFor(() => b.calls.badges.at(-1)?.text === '1');
  b.addDeepSearchMedia(11, ['https://example.invalid/a.mp4', 'https://example.invalid/b.mp4'], 'https://example.invalid/page');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.badges.filter(badge => badge.tabId === 11).at(-1).text, '1');
  await push([{ id: 'one', status: 'active' }, { id: 'two', status: 'error', name: 'failed.zip', errorMessage: 'HTTP 404' }]);
  await waitFor(() => b.calls.badges.at(-1)?.text === 'X');
  assert.equal(b.downloadStatus().errors[0].name, 'failed.zip');
  await push([{ id: 'one', status: 'complete' }, { id: 'two', status: 'paused' }]);
  await waitFor(() => b.calls.badges.filter(badge => badge.tabId === 11).at(-1)?.text === '2');
  assert.equal(b.calls.badges.filter(badge => badge.tabId === 12).at(-1).text, '');
  assert.equal(b.calls.badgeColors.filter(badge => badge.tabId === 11).at(-1).color, '#2563eb');
  b.listeners.tabUpdated(11, { status: 'loading' });
  await waitFor(() => b.calls.badges.filter(badge => badge.tabId === 11).at(-1)?.text === '');
  assert.equal(b.sniffedMedia.has(11), false);
});

test('badge totals include every routed server and deduplicate repeated server routes', async () => {
  const b = backgroundFixture();
  b.local.servers = [
    { url: 'http://machine-a.invalid', pattern: '*.zip' },
    { url: 'http://machine-b.invalid', pattern: '*' },
    { url: 'http://machine-a.invalid', pattern: '*.mp4' },
  ];
  b.controls.get = async url => ({ ok: true, json: async () => ({
    tasks: url.includes('machine-a') ? [{ id: 'a', status: 'active' }] :
      [{ id: 'b', status: 'waiting' }, { id: 'c', status: 'waiting' }],
  }) });
  await b.connectEvents();
  await b.refreshBadge();
  await waitFor(() => b.downloadStatus().ongoing === 3);
  assert.equal(b.downloadStatus().active, 1);
  assert.equal(b.downloadStatus().waiting, 2);
});

test('sending displays a count immediately and failed handoffs persist until acknowledged', async () => {
  const b = backgroundFixture();
  b.local.allowExternalRequest = true;
  const deferredPost = deferred();
  b.controls.post = () => deferredPost.promise;
  const result = new Promise(resolve => b.listeners.externalMessage({
    type: 'download', url: 'https://example.invalid/file.zip',
  }, { id: 'other-extension' }, resolve));
  await waitFor(() => b.calls.badges.some(badge => badge.text === '1'));
  deferredPost.reject(new Error('fixture offline'));
  assert.match((await result).error, /fixture offline/);
  await waitFor(() => b.calls.badges.at(-1)?.text === 'X');
  const restarted = backgroundFixture({ persisted: structuredClone(b.session) });
  await restarted.refreshBadge();
  assert.ok(restarted.downloadStatus().handoffFailure);
  await new Promise(resolve => restarted.listeners.message({ type: 'clearHandoffError' }, {}, resolve));
  await waitFor(() => restarted.calls.badges.at(-1)?.text === '');
});

test('default detection recognizes opaque media and downloadable attachments from response filenames', async () => {
  const b = backgroundFixture();
  await b.mediaRestore;
  const response = (url, disposition, statusCode = 200) => b.listeners.response({
    tabId: 5, requestId: url, url, statusCode, type: 'xmlhttprequest',
    responseHeaders: [
      { name: 'Content-Type', value: 'application/octet-stream' },
      { name: 'Content-Disposition', value: disposition },
      { name: 'Content-Range', value: 'bytes 0-999/9000' },
    ],
  });
  response('https://example.invalid/export?id=1', "inline; filename*=UTF-8''%E6%B5%8B%E8%AF%95.mp4");
  response('https://example.invalid/export?id=2', 'attachment; filename="archive.zip"');
  response('https://example.invalid/export?id=3', 'attachment; filename="missing.mp4"', 404);
  await waitFor(() => b.sniffedMedia.get(5)?.size === 2);
  assert.equal(b.sniffedMedia.get(5).get('https://example.invalid/export?id=1').filename, '测试.mp4');
  assert.equal(b.sniffedMedia.get(5).get('https://example.invalid/export?id=2').size, 9000);
});
