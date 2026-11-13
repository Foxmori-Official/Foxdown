import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { isolateServer } from '../helpers/server-fixture.mjs';

test('native segment byte ranges are validated before accepting any data', async t => {
  isolateServer(t);
  const { NativeStreamEngine } = await import('../../server/src/stream/native.js');
  const engine = new NativeStreamEngine({}, { streamTimeoutMs: 1000 });
  let response = { status: 206, range: 'bytes 4-7/12', body: '4567' };
  let requestedRange, requestedEncoding;
  const server = http.createServer((req, res) => {
    requestedRange = req.headers.range;
    requestedEncoding = req.headers['accept-encoding'];
    const headers = response.range ? { 'Content-Range': response.range } : {};
    if (response.encoding) headers['Content-Encoding'] = response.encoding;
    res.writeHead(response.status, headers);
    res.end(response.body);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const uri = `http://127.0.0.1:${server.address().port}/segment`;
  const ctx = { abort: new AbortController() };
  const segment = { uri, byterange: [4, 4] };
  assert.equal((await engine._fetchSegment(ctx, segment, {})).toString(), '4567');
  await fs.mkdir(engine._dir('ranged-init'), { recursive: true });
  const init = await engine._ensureInit({ id: 'ranged-init' }, ctx, uri, {}, 'init.bin', '4@4');
  assert.equal(await fs.readFile(init, 'utf8'), '4567');
  assert.equal(requestedRange, 'bytes=4-7', 'HLS init ranges must use the same range validation as media segments');
  assert.equal(requestedRange, 'bytes=4-7');
  assert.ok(requestedEncoding.split(',').every(value => value.trim() === 'identity'), 'request must not allow compressed range bytes');
  assert.equal((await engine._fetchSegment(ctx, segment, { range: 'bytes=0-1', 'accept-encoding': 'gzip' })).toString(), '4567');
  assert.equal(requestedRange, 'bytes=4-7', 'replace inherited Range case-insensitively');
  for (const invalid of [
    { status: 200, range: null, body: '0123456789ab' },
    { status: 206, range: null, body: '4567' },
    { status: 206, range: 'bytes 4-7/12', encoding: 'gzip', body: '4567' },
    { status: 206, range: 'bytes 0-3/12', body: '0123' },
    { status: 206, range: 'bytes 4-8/12', body: '45678' },
    { status: 206, range: 'bytes 4-7/7', body: '4567' },
    { status: 206, range: 'bytes 4-7/12', body: '45' },
    { status: 206, range: 'bytes 4-7/12', body: '45678' },
  ]) {
    response = invalid;
    await assert.rejects(engine._fetchSegment(ctx, segment, {}), /byte-range response/);
  }
  response = { status: 206, range: 'bytes 4-7/*', body: '4567' };
  assert.equal((await engine._fetchSegment(ctx, segment, {})).length, 4);
  response = { status: 200, range: null, body: 'whole segment' };
  assert.equal((await engine._fetchSegment(ctx, { uri }, {})).toString(), 'whole segment');
  for (const byterange of [[-1, 4], [0, 0], [0, -1], [1.5, 4], [0, Infinity], [Number.MAX_SAFE_INTEGER, 4]]) {
    await assert.rejects(engine._fetchSegment(ctx, { uri, byterange }, {}), /Invalid byte-range request/);
  }
  ctx.abort.abort();
  await assert.rejects(engine._fetchSegment(ctx, segment, {}), { name: 'AbortError' });
});
