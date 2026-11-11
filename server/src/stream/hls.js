/**
 * HLS playlist parser (master + media). Pure string parsing, no deps.
 * Reference: RFC 8216, aligned with N_m3u8DL-RE's HLSExtractor semantics.
 */

/** Parse a comma-separated attribute list: KEY=VALUE,KEY="V,A,L"... */
export function parseAttrs(line) {
  const attrs = {};
  let i = 0;
  const n = line.length;
  while (i < n) {
    // skip whitespace / commas
    while (i < n && /[\s,]/.test(line[i])) i++;
    if (i >= n) break;
    let key = '';
    while (i < n && line[i] !== '=') { key += line[i]; i++; }
    i++; // skip '='
    let val = '';
    if (line[i] === '"') {
      i++;
      while (i < n && line[i] !== '"') { val += line[i]; i++; }
      i++; // skip closing quote
    } else {
      while (i < n && line[i] !== ',' && line[i] !== '\n') { val += line[i]; i++; }
      val = val.trim();
    }
    attrs[key.trim()] = val;
  }
  return attrs;
}

const abs = (uri, base) => {
  try { return new URL(uri, base).href; } catch { return uri; }
};

/**
 * Parse a master playlist.
 * @returns {{master:true, variants:Array, audioTracks:Array, subtitles:Array}}
 * variant: {id, uri, bandwidth, averageBandwidth, resolution, width, height,
 *           frameRate, codecs, audio(group), video(group), name}
 */
export function parseMaster(text, baseUrl) {
  const variants = [];
  const audioTracks = [];
  const subtitles = [];
  const lines = text.split(/\r?\n/);
  let pending = null; // last #EXT-X-STREAM-INF attrs
  let idc = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      const entry = {
        type: a.TYPE,
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        uri: a.URI ? abs(a.URI, baseUrl) : null,
        channels: a.CHANNELS || '',
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
      };
      if (a.TYPE === 'AUDIO') audioTracks.push(entry);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(entry);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      // skip iframe-only renditions
      pending = null;
    } else if (!line.startsWith('#') && pending) {
      const bw = Number(pending.BANDWIDTH || 0) || 0;
      const res = pending.RESOLUTION || '';
      let width = 0, height = 0;
      const m = /^(\d+)x(\d+)$/.exec(res);
      if (m) { width = Number(m[1]); height = Number(m[2]); }
      const name = pending.NAME || (height ? `${height}p` : `${Math.round(bw / 1000)}k`);
      variants.push({
        id: name || `v${idc++}`,
        uri: abs(line, baseUrl),
        bandwidth: bw,
        averageBandwidth: Number(pending['AVERAGE-BANDWIDTH'] || 0) || 0,
        resolution: res,
        width, height,
        frameRate: Number(pending['FRAME-RATE'] || 0) || 0,
        codecs: pending.CODECS || '',
        audio: pending.AUDIO || '',
        video: pending.VIDEO || '',
        name,
      });
      pending = null;
    }
  }
  return { master: true, variants, audioTracks, subtitles };
}

/**
 * Parse a media playlist.
 * @returns {{master:false, segments:Array, mediaSequence:number,
 *   targetDuration:number, endList:boolean, playlistType:string,
 *   key:?object, map:?object, duration:number}}
 * segment: {uri, duration, title?, key?, map?, byterange?, discontinuity?,
 *           programDateTime?, sequence}
 */
export function parseMedia(text, baseUrl) {
  const segments = [];
  const lines = text.split(/\r?\n/);
  let mediaSequence = 0;
  let targetDuration = 0;
  let endList = false;
  let playlistType = '';
  let curKey = null;          // active EXT-X-KEY
  let curMap = null;          // active EXT-X-MAP
  let pendingByterange = null;
  let pendingDiscontinuity = false;
  let pendingDateTime = null;
  let pendingDuration = null;
  let pendingTitle = null;
  let seq = 0;
  const keys = [];            // dedupe table not needed; per-segment snapshot

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      if ((a.METHOD || '').toUpperCase() === 'NONE') curKey = null;
      else {
        curKey = {
          method: (a.METHOD || 'AES-128').toUpperCase(),
          uri: a.URI ? abs(a.URI, baseUrl) : null,
          iv: a.IV || null,
          keyFormat: a.KEYFORMAT || 'identity',
        };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      curMap = { uri: a.URI ? abs(a.URI, baseUrl) : null, byterange: a.BYTERANGE || null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByterange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingDateTime = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
    } else if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length);
      const ci = rest.indexOf(',');
      const num = ci >= 0 ? rest.slice(0, ci) : rest;
      pendingDuration = parseFloat(num) || 0;
      pendingTitle = ci >= 0 ? rest.slice(ci + 1).trim() : '';
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
    } else if (!line.startsWith('#')) {
      // a segment URI line
      const seg = {
        uri: abs(line, baseUrl),
        duration: pendingDuration ?? 0,
        sequence: mediaSequence + seq,
      };
      if (pendingTitle) seg.title = pendingTitle;
      if (curKey) seg.key = { ...curKey };
      if (curMap) seg.map = { ...curMap };
      if (pendingByterange) seg.byterange = pendingByterange;
      if (pendingDiscontinuity) seg.discontinuity = true;
      if (pendingDateTime) seg.programDateTime = pendingDateTime;
      segments.push(seg);
      seq++;
      pendingByterange = null;
      pendingDiscontinuity = false;
      pendingDateTime = null;
      pendingDuration = null;
      pendingTitle = null;
    }
  }

  const duration = segments.reduce((s, x) => s + (x.duration || 0), 0);
  return {
    master: false,
    segments,
    mediaSequence,
    targetDuration,
    endList,
    playlistType,
    key: curKey,
    map: curMap,
    duration,
  };
}

/** Detect master vs media playlist. */
export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF[:\s]/i.test(text);
}
