import test from 'node:test';
import assert from 'node:assert/strict';
import { popupFixture } from '../helpers/popup-fixture.mjs';
import { waitFor } from '../helpers/extension-background.mjs';
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };

test('popup stats requests are single-flight until body consumption completes', async () => {
  const b = popupFixture();
  const body = deferred();
  let requests = 0;
  b.controls.fetch = async () => { requests++; return { ok: true, json: () => body.promise }; };
  const first = b.load();
  await waitFor(() => requests === 1);
  await b.load();
  assert.equal(requests, 1);
  assert.equal(b.timers.size, 1, 'timeout stays armed while body is pending');
  body.resolve({ numActive: 2, numWaiting: 3, downloadSpeed: 1024, uploadSpeed: 0 });
  await first;
  assert.equal(b.timers.size, 0);
  assert.equal(b.elements.get('active').textContent, 2);
  assert.equal(b.elements.get('upspeed').textContent, '0 B/s');
  await b.load();
  assert.equal(requests, 2);
});

test('stats timeout aborts a hung response body and releases single-flight gate', async () => {
  const b = popupFixture();
  let reading = false;
  b.controls.fetch = async (_url, { signal }) => ({
    ok: true, json: () => new Promise((_resolve, reject) => {
      reading = true;
      signal.addEventListener('abort', () => reject(new Error('aborted body')));
    }),
  });
  const first = b.load();
  await waitFor(() => reading);
  const [timer] = b.timers.values();
  assert.equal(timer.delay, 5000);
  timer.callback();
  await first;
  assert.equal(b.elements.get('state').style.color, '#dc2626');
  b.controls.fetch = async () => ({ ok: true, json: async () => ({ numActive: 9 }) });
  await b.load();
  assert.equal(b.elements.get('active').textContent, 9);
});

test('media listing is single-flight during extension messaging', async () => {
  const b = popupFixture();
  const response = deferred();
  let requests = 0;
  b.controls.message = message => {
    if (message.type === 'getSniffedMedia') { requests++; return response.promise; }
    return Promise.resolve({ error: 'expired' });
  };
  const first = b.loadMedia();
  await waitFor(() => requests === 1);
  await b.loadMedia();
  assert.equal(requests, 1);
  response.resolve([]);
  await first;
  await b.loadMedia();
  assert.equal(requests, 2);
});

test('ordinary media and native HLS do not load hls.js', async () => {
  const b = popupFixture();
  assert.equal(b.scripts.length, 0);
  await b.previewMedia({ url: 'https://example.invalid/file.mp4', type: 'VIDEO' });
  assert.equal(b.scripts.length, 0);
  assert.equal(b.elements.get('previewPlayer').children[0].src, 'https://example.invalid/file.mp4');
  b.controls.nativeHls = true;
  await b.previewMedia({ url: 'https://example.invalid/live.m3u8', type: 'HLS' });
  assert.equal(b.scripts.length, 0);
});

test('HLS loader is single-flight; closing preview before script loads prevents stale playback', async () => {
  const b = popupFixture();
  let created = 0;
  const preview = b.previewMedia({ url: 'https://example.invalid/live.m3u8', type: 'HLS' });
  const duplicate = b.loadHlsLibrary();
  assert.equal(b.scripts.length, 1);
  b.closePreview();
  b.window.Hls = class { constructor() { created++; } };
  b.scripts[0].onload();
  await Promise.all([preview, duplicate]);
  assert.equal(created, 0);
  assert.equal(b.elements.get('previewBox').style.display, 'none');
});

test('HLS loader can retry after script failure', async () => {
  const b = popupFixture();
  const failed = assert.rejects(b.loadHlsLibrary(), /HLS player unavailable/);
  b.scripts[0].onerror();
  await failed;
  assert.equal(b.scripts[0].removed, true);
  const retry = b.loadHlsLibrary();
  assert.equal(b.scripts.length, 2);
  b.window.Hls = class {};
  b.scripts[1].onload();
  await retry;
});
