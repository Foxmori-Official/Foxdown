import { isMagnet, isTorrentUrl, isStreamUrl, guessFilename } from '../util/helpers.js';
import { readMetadata } from '../util/metadata.js';

/** Minimal bencode decoder - enough to read .torrent info (name, files, size). */
function bdecode(buf) {
  let i = 0;
  let entries = 0;
  function read(depth = 0) {
    if (i >= buf.length || depth > 64 || ++entries > 100000) throw new Error('invalid or excessive torrent data');
    const c = buf[i];
    if (c === 0x69) { // i<int>e
      const e = buf.indexOf(0x65, i + 1);
      if (e < 0) throw new Error('unterminated torrent integer');
      const text = buf.subarray(i + 1, e).toString();
      if (!/^(?:0|-?[1-9]\d*)$/.test(text)) throw new Error('invalid torrent integer');
      const n = Number(text);
      if (!Number.isSafeInteger(n)) throw new Error('torrent integer exceeds safe range');
      i = e + 1;
      return n;
    }
    if (c === 0x6c) {
      i++;
      const list = [];
      while (buf[i] !== 0x65) list.push(read(depth + 1));
      i++;
      return list;
    }
    if (c === 0x64) {
      i++;
      const dictionary = Object.create(null);
      while (buf[i] !== 0x65) {
        const key = read(depth + 1);
        if (!Buffer.isBuffer(key)) throw new Error('torrent dictionary key must be a string');
        dictionary[key.toString()] = read(depth + 1);
      }
      i++;
      return dictionary;
    }
    // string: <len>:<bytes>
    let j = i;
    while (buf[j] >= 0x30 && buf[j] <= 0x39) j++;
    const len = Number(buf.subarray(i, j).toString());
    if (j === i || buf[j] !== 0x3a || !Number.isSafeInteger(len) || len < 0 || len > buf.length - j - 1) {
      throw new Error('invalid torrent string length');
    }
    i = j + 1;
    const s = buf.subarray(i, i + len);
    i += len;
    return s;
  }
  const result = read();
  if (i !== buf.length) throw new Error('unexpected trailing torrent data');
  return result;
}

const txt = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b);

export function parseTorrent(buf) {
  const t = bdecode(buf);
  if (!t || Buffer.isBuffer(t) || Array.isArray(t) || !t.info || typeof t.info !== 'object' || Buffer.isBuffer(t.info) || Array.isArray(t.info)) {
    throw new Error('torrent info dictionary required');
  }
  const info = t.info;
  const name = txt(info['name.utf-8'] || info.name || 'torrent');
  let totalLength = 0;
  const files = [];
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const p = (f['path.utf-8'] || f.path || []).map(txt).join('/');
      files.push({ path: p, length: Number(f.length || 0) });
      totalLength += Number(f.length || 0);
    }
  } else {
    totalLength = Number(info.length || 0);
    files.push({ path: name, length: totalLength });
  }
  const announce = txt(t.announce || '');
  const announceList = Array.isArray(t['announce-list']) ? t['announce-list'].flat().map(txt) : [];
  return { name, totalLength, files, trackers: [...new Set([announce, ...announceList].filter(Boolean))] };
}

/**
 * Resolve a URL into a task descriptor (Gopeed-style resolve step).
 * @param {string} url
 * @param {{headers?: string[], stream?: import('../stream/index.js').StreamManager}} ctx
 */
export async function probeUrl(url, { headers = [], stream } = {}) {
  if (isMagnet(url)) {
    return { type: 'torrent', url, name: 'Magnet 链接', magnet: true };
  }
  const headerObj = {};
  for (const h of headers) {
    const idx = h.indexOf(':');
    if (idx > 0) headerObj[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  if (isStreamUrl(url)) {
    const info = await stream.probe(url, headerObj);
    return { type: 'stream', url, ...info };
  }

  const resp = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-0', ...headerObj },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const cd = resp.headers.get('content-disposition') || '';
  const ct = resp.headers.get('content-type') || '';
  const cr = resp.headers.get('content-range') || '';
  const acceptRanges = resp.headers.get('accept-ranges');
  let size = 0;
  const m = /\/(\d+)\s*$/.exec(cr);
  if (m) size = Number(m[1]);
  else if (resp.headers.get('content-length')) size = Number(resp.headers.get('content-length'));

  const name = guessFilename(url, cd) || 'download';

  if (isTorrentUrl(url) || ct.includes('x-bittorrent') || name.endsWith('.torrent')) {
    let torrentResponse = resp;
    if (resp.status === 206) {
      await resp.body?.cancel();
      const fullHeaders = new Headers(headerObj);
      fullHeaders.delete('range');
      torrentResponse = await fetch(resp.url || url, {
        headers: fullHeaders, redirect: 'follow', signal: AbortSignal.timeout(20000),
      });
      if (!torrentResponse.ok) {
        await torrentResponse.body?.cancel();
        throw new Error(`HTTP ${torrentResponse.status} ${torrentResponse.statusText}`);
      }
    }
    const buf = await readMetadata(torrentResponse);
    try {
      const t = parseTorrent(buf);
      return { type: 'torrent', url, name: t.name, totalLength: t.totalLength, files: t.files, trackers: t.trackers, torrentBase64: buf.toString('base64') };
    } catch {
      return { type: 'torrent', url, name, totalLength: size };
    }
  }

  // drain body
  try { await resp.body?.cancel(); } catch {}

  return {
    type: 'file',
    url: resp.url || url,
    name,
    totalLength: size,
    resumable: acceptRanges === 'bytes' || resp.status === 206,
    contentType: ct,
  };
}
