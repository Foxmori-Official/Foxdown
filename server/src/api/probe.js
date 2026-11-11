import { isMagnet, isTorrentUrl, isStreamUrl, guessFilename } from '../util/helpers.js';

/** Minimal bencode decoder - enough to read .torrent info (name, files, size). */
function bdecode(buf) {
  let i = 0;
  function read() {
    const c = buf[i];
    if (c === 0x69) { // i<int>e
      const e = buf.indexOf(0x65, i);
      const n = Number(buf.subarray(i + 1, e).toString());
      i = e + 1;
      return n;
    }
    if (c === 0x6c) { i++; const l = []; while (buf[i] !== 0x65) l.push(read()); i++; return l; }
    if (c === 0x64) { i++; const d = {}; while (buf[i] !== 0x65) { const k = read(); d[k.toString()] = read(); } i++; return d; }
    // string: <len>:<bytes>
    let j = i;
    while (buf[j] >= 0x30 && buf[j] <= 0x39) j++;
    const len = Number(buf.subarray(i, j).toString());
    i = j + 1;
    const s = buf.subarray(i, i + len);
    i += len;
    return s;
  }
  return read();
}

const txt = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b);

export function parseTorrent(buf) {
  const t = bdecode(buf);
  const info = t.info || {};
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
    const buf = Buffer.from(await resp.arrayBuffer());
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
