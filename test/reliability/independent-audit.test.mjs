import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { parseTorrent, probeUrl } from '../../server/src/api/probe.js';
import { parseMpd } from '../../server/src/stream/dash.js';
import { MAX_METADATA_BYTES, readMetadata } from '../../server/src/util/metadata.js';
import { reserveOutputPath } from '../../server/src/util/paths.js';
import { isolateServer } from '../helpers/server-fixture.mjs';

test('truncated torrent dictionaries cannot block the server event loop', () => {
  // A process timeout also detects a regression to the original synchronous loop.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { parseTorrent } from ${JSON.stringify(new URL('../../server/src/api/probe.js', import.meta.url).href)};
    for (const input of ['d4:info', 'd4:infod', 'l', 'i12', 'i-0e', 'd4:infoi1ee', 'd4:infod4:name9:shorte', 'd4:infodeejunk']) {
      assert.throws(() => parseTorrent(Buffer.from(input)), undefined, input);
    }
    assert.throws(() => parseTorrent(Buffer.from('l'.repeat(100) + 'e'.repeat(100))), /excessive/);
  `], { timeout: 3000, stdio: 'pipe' });
  assert.deepEqual(parseTorrent(Buffer.from('d4:infod6:lengthi8e4:name8:file.binee')), {
    name: 'file.bin', totalLength: 8, files: [{ path: 'file.bin', length: 8 }], trackers: [],
  });
});

test('network metadata respects declared and streamed size limits', async () => {
  assert.equal((await readMetadata(new Response('small'), 8)).toString(), 'small');
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'Content-Length': String(MAX_METADATA_BYTES + 1) },
  });
  await assert.rejects(readMetadata(oversized), /size limit/);
  assert.equal(cancelled, true);
  cancelled = false;
  const chunked = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(5)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readMetadata(chunked, 8), /size limit/);
  assert.equal(cancelled, true);
});

test('tracker sources also enforce the metadata budget before splitting the list', async () => {
  const { fetchTrackerList } = await import('../../server/src/util/trackers.js');
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('udp://fixture.invalid:80/announce\n# comment');
    assert.equal((await fetchTrackerList('https://fixture.invalid/trackers')).trackers, 'udp://fixture.invalid:80/announce');
    globalThis.fetch = async () => new Response('oversized', { headers: { 'Content-Length': MAX_METADATA_BYTES + 1 } });
    await assert.rejects(fetchTrackerList('https://fixture.invalid/trackers'), /size limit/);
  } finally { globalThis.fetch = previous; }
});

test('resolving a range-capable torrent fetches complete bounded metadata and rejects HTTP errors', async t => {
  const torrent = Buffer.from('d4:infod6:lengthi8e4:name8:file.binee');
  const requests = [];
  const fixture = http.createServer((request, response) => {
    if (request.url === '/missing.bin') return response.writeHead(404).end();
    if (request.url === '/large.torrent') return response.writeHead(200, {
      'Content-Length': MAX_METADATA_BYTES + 1, 'Content-Type': 'application/x-bittorrent',
    }).end();
    requests.push(request.headers.range || 'full');
    if (request.headers.range) return response.writeHead(206, {
      'Content-Range': `bytes 0-0/${torrent.length}`, 'Content-Type': 'application/x-bittorrent',
    }).end(torrent.subarray(0, 1));
    response.writeHead(200, { 'Content-Type': 'application/x-bittorrent' }).end(torrent);
  }).listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const resolved = await probeUrl(origin + '/sample.torrent');
  assert.equal(resolved.name, 'file.bin');
  assert.equal(resolved.totalLength, 8);
  assert.deepEqual(Buffer.from(resolved.torrentBase64, 'base64'), torrent);
  assert.deepEqual(requests, ['bytes=0-0', 'full']);
  await assert.rejects(probeUrl(origin + '/missing.bin'), /HTTP 404/);
  await assert.rejects(probeUrl(origin + '/large.torrent'), /size limit/);
});

const mpd = template => `<MPD mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4">
  <Representation id="video">${template}</Representation></AdaptationSet></Period></MPD>`;
const baseUrl = 'https://fixture.invalid/movie.mpd';

test('DASH decodes signed URL entities and expands negative repeats to their finite end', () => {
  const result = parseMpd(mpd('<SegmentTemplate media="segment-$Number$.m4s?a=1&amp;b=&#50;&#x33;" duration="2"/>'), baseUrl);
  assert.equal(result.representations[0].segments[0].url, 'https://fixture.invalid/segment-1.m4s?a=1&b=23');
  const repeated = parseMpd(mpd('<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate>'), baseUrl);
  assert.deepEqual(repeated.representations[0].segments.map(s => s.time), [0, 2, 4]);
  const bounded = parseMpd(mpd('<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/><S t="4" d="2"/></SegmentTimeline></SegmentTemplate>'), baseUrl);
  assert.deepEqual(bounded.representations[0].segments.map(s => s.time), [0, 2, 4]);
  const offset = parseMpd(mpd('<SegmentTemplate media="$Time$.m4s" presentationTimeOffset="100"><SegmentTimeline><S t="100" d="2" r="-1"/></SegmentTimeline></SegmentTemplate>'), baseUrl);
  assert.deepEqual(offset.representations[0].segments.map(s => s.time), [100, 102, 104]);
});

test('DASH inherits BaseURL at every level and avoids duplicating whole-file SegmentBase init data', () => {
  const document = '<MPD><BaseURL>media/</BaseURL><Period><BaseURL>period/</BaseURL><AdaptationSet><BaseURL>video/</BaseURL><Representation id="v"><BaseURL>whole.mp4?x=1&amp;y=2</BaseURL><SegmentBase><Initialization range="0-100"/></SegmentBase></Representation></AdaptationSet></Period></MPD>';
  const [track] = parseMpd(document, baseUrl).representations;
  assert.equal(track.initUrl, null);
  assert.equal(track.segments[0].url, 'https://fixture.invalid/media/period/video/whole.mp4?x=1&y=2');
});

test('DASH limits repeat expansion, total tracks, URL amplification, XML depth and padding', () => {
  for (const template of [
    '<SegmentTemplate media="$Number$.m4s"><SegmentTimeline><S d="1" r="1000000000"/></SegmentTimeline></SegmentTemplate>',
    '<SegmentTemplate media="$Number$.m4s" duration="0.0000001"/>',
    '<SegmentTemplate media="$Number%099999999d$.m4s" duration="2"/>',
    '<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="0"/></SegmentTimeline></SegmentTemplate>',
  ]) assert.throws(() => parseMpd(mpd(template), baseUrl), /limit|duration/);
  const manyTracks = `<MPD><Period><AdaptationSet>${[1, 2].map(id => `<Representation id="${id}"><SegmentTemplate media="$Number$.m4s"><SegmentTimeline><S d="1" r="59999"/></SegmentTimeline></SegmentTemplate></Representation>`).join('')}</AdaptationSet></Period></MPD>`;
  assert.throws(() => parseMpd(manyTracks, baseUrl), /limit/);
  assert.throws(() => parseMpd(mpd(`<SegmentTemplate media="${'a'.repeat(120000)}-$Number$.m4s"><SegmentTimeline><S d="1" r="299"/></SegmentTimeline></SegmentTemplate>`), baseUrl), /URLs exceed/);
  assert.throws(() => parseMpd('<MPD>' + '<X>'.repeat(70) + '</X>'.repeat(70) + '</MPD>', baseUrl), /structure exceeds/);
});

test('independent engine checks use isolated outputs, simulated gateways and child processes', async t => {
  const root = isolateServer(t);
  const previousBin = process.env.FOXDOWN_BIN_DIR;
  process.env.FOXDOWN_BIN_DIR = path.join(root, 'bin');
  t.after(() => { if (previousBin === undefined) delete process.env.FOXDOWN_BIN_DIR; else process.env.FOXDOWN_BIN_DIR = previousBin; });
  const { NativeStreamEngine } = await import('../../server/src/stream/native.js');
  const { ExternalStreamEngine } = await import('../../server/src/stream/external.js');
  const { UpnpManager } = await import('../../server/src/upnp/index.js');
  const { NM3U8_BIN } = await import('../../server/src/config.js');
  const tasks = new Map();
  const store = {
    getStreamTask: id => tasks.get(id),
    updateStreamTask(id, patch) { const task = tasks.get(id); if (task) Object.assign(task, patch); return task; },
  };

  await t.test('concurrent output reservations preserve files and symlinks', async () => {
    const directory = path.join(root, 'reservations');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'video.mp4'), 'existing');
    const reserved = await Promise.all(Array.from({ length: 12 }, () => reserveOutputPath(directory, 'video.mp4')));
    assert.equal(new Set(reserved).size, 12);
    assert.equal(await fs.readFile(path.join(directory, 'video.mp4'), 'utf8'), 'existing');
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(directory, 'video.mp4'), path.join(directory, 'linked.mp4'));
      assert.equal(path.basename(await reserveOutputPath(directory, 'linked.mp4')), 'linked (1).mp4');
      assert.equal(await fs.readFile(path.join(directory, 'video.mp4'), 'utf8'), 'existing');
    }
  });
  await t.test('native stream finalization preserves duplicate files and removes failed reservations', async () => {
    const native = new NativeStreamEngine(store, {});
    const saveDir = path.join(root, 'streams');
    await fs.mkdir(saveDir);
    await fs.writeFile(path.join(saveDir, 'video.ts'), 'existing');
    async function fixture(id, name, missing = false) {
      const task = { id, name, saveDir, options: { mux: false } };
      tasks.set(id, task);
      const directory = native._dir(id);
      await fs.mkdir(directory, { recursive: true });
      if (!missing) await fs.writeFile(path.join(directory, 'segment.ts'), 'segment');
      const ctx = native._mkCtx(task);
      ctx.manifest = { segments: { 0: { idx: 0, file: 'segment.ts' } }, totalSegments: 1 };
      return { task, ctx };
    }
    const fixtures = await Promise.all([fixture('a', 'video.ts'), fixture('b', 'video.ts')]);
    await Promise.all(fixtures.map(({ task, ctx }) => native._finalize(task, ctx, { format: 'hls' })));
    assert.deepEqual(new Set(fixtures.map(({ task }) => task.outputName)), new Set(['video (1).ts', 'video (2).ts']));
    assert.equal(await fs.readFile(path.join(saveDir, 'video.ts'), 'utf8'), 'existing');
    for (const { task } of fixtures) assert.equal(await fs.readFile(task.outputFiles[0], 'utf8'), 'segment');
    const broken = await fixture('broken', 'failed', true);
    native.on('error', () => {});
    native._run = (task, ctx) => native._finalize(task, ctx, { format: 'hls' });
    await native._execute(broken.task, broken.ctx);
    assert.equal(broken.task.status, 'error');
    assert.equal(await fs.access(path.join(saveDir, 'failed.ts')).then(() => true, () => false), false);
  });
  await t.test('stream start acknowledges immediately and shutdown waits for active writes', async () => {
    const native = new NativeStreamEngine(store, {});
    let release;
    const held = new Promise(resolve => { release = resolve; });
    native._run = async (task, ctx) => { await once(ctx.abort.signal, 'abort'); await held; };
    const task = { id: 'background-start', options: {} };
    tasks.set(task.id, task);
    const started = native.start(task);
    try {
      assert.equal(await Promise.race([started.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]), true);
      assert.equal(native.runs.size, 1);
      let stopped = false;
      const shutdown = native.shutdownAll().then(() => { stopped = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(stopped, false);
      release();
      await shutdown;
      assert.equal(native.runs.size, 0);
    } finally { release(); await native.shutdownAll(); await started; }
  });
  await t.test('HLS implicit byte ranges start at the preceding explicit range end', () => {
    const native = new NativeStreamEngine(store, {});
    const plan = native._hlsSegmentPlan({ segments: [
      { uri: 'https://fixture.invalid/media.mp4', sequence: 0, byterange: '4@100' },
      { uri: 'https://fixture.invalid/media.mp4', sequence: 1, byterange: '4' },
      { uri: 'https://fixture.invalid/media.mp4', sequence: 2, byterange: '4' },
    ] });
    assert.deepEqual(plan.segments.map(segment => segment.byterange), [[100, 4], [104, 4], [108, 4]]);
  });
  await t.test('external progress uses correct speed units and spawn errors become task errors', async () => {
    const engine = new ExternalStreamEngine(store, {});
    const task = { id: 'external', url: 'https://fixture.invalid/movie.m3u8', saveDir: root };
    tasks.set(task.id, task);
    engine._parseLine(task.id, 'Vid 1080p | 45.6% | 456/1000 | 2.35MBps | 00:01:23');
    assert.equal(task.downloadSpeed, 2.35 * 1024 ** 2);
    assert.equal(task.progress.doneSegments, 456);
    const failure = once(engine, 'error');
    await engine.start(task);
    const [failed] = await failure;
    assert.equal(failed.status, 'error');
    assert.match(failed.errorMessage, /ENOENT/);
    assert.equal(engine.running.size, 0);
  });
  await t.test('an old external process cannot finish or remove a resumed process', { skip: process.platform === 'win32' }, async () => {
    await fs.mkdir(path.dirname(NM3U8_BIN), { recursive: true });
    await fs.writeFile(NM3U8_BIN, `#!${process.execPath}\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));\nsetInterval(() => {}, 1000);\nconsole.log('ready');\n`, { mode: 0o755 });
    const engine = new ExternalStreamEngine(store, {});
    engine.on('error', () => {});
    const task = { id: 'resumed', url: 'https://fixture.invalid/movie.m3u8', saveDir: root };
    tasks.set(task.id, task);
    try {
      await engine.start(task);
      const old = engine.running.get(task.id);
      await once(old.stdout, 'data');
      const exited = once(old, 'exit');
      await engine.pause(task);
      await engine.resume(task);
      const resumed = engine.running.get(task.id);
      assert.notEqual(resumed, old);
      await exited;
      assert.equal(engine.running.get(task.id), resumed);
      assert.equal(task.status, 'downloading');
      const stopped = once(resumed, 'exit');
      await engine.pause(task);
      await stopped;
    } finally { await engine.shutdownAll(); }
  });
  await t.test('Promise-based UPnP changes serialize and unmap previous ports', async () => {
    const manager = new UpnpManager({});
    const calls = [];
    manager.client = {
      async map(port) { calls.push(['map', port]); await new Promise(resolve => setTimeout(resolve, 10)); },
      async unmap(port) { calls.push(['unmap', port]); },
      async destroy() { calls.push(['destroy']); },
    };
    await Promise.all([
      manager.apply({ upnpEnabled: true, listenPort: 51413 }),
      manager.apply({ upnpEnabled: true, listenPort: 51414 }),
      manager.apply({ upnpEnabled: false, listenPort: 51414 }),
    ]);
    await manager.destroy();
    assert.deepEqual(calls, [['map', 51413], ['unmap', 51413], ['map', 51414], ['unmap', 51414], ['destroy']]);
    assert.equal(manager.mappedPorts.size, 0);
    assert.equal(manager.client, null);
    manager.client = { map: async () => false, destroy: async () => {} };
    assert.equal(await manager.map(51413), false);
    assert.equal(manager.mappedPorts.size, 0);
    await manager.destroy();
  });
});
