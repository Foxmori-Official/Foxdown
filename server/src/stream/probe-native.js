/**
 * Native stream prober: fetches an m3u8/mpd manifest and summarizes it
 * in the unified shape used by api/probe.js and the web UI.
 *
 * probeStream(url, headers) -> {
 *   format: 'hls'|'dash', live, name,
 *   variants: [{id, bandwidth, resolution, frameRate, codecs, audio}],
 *   duration?
 * }
 */
import { parseMaster, parseMedia, isMasterPlaylist } from './hls.js';
import { parseMpd } from './dash.js';
import { streamFormat } from '../util/helpers.js';

async function fetchText(url, headers, timeoutMs = 20000, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return await resp.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function nameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    return base.replace(/\.[^.]+$/, '');
  } catch { return ''; }
}

/**
 * @param {string} url
 * @param {Record<string,string>|string[]} [headers] header object or "K: V" list
 */
export async function probeStream(url, headers = {}) {
  let hdrObj = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const i = h.indexOf(':');
      if (i > 0) hdrObj[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
  } else {
    hdrObj = { ...headers };
  }

  const text = await fetchText(url, hdrObj);
  const sniffed = /^\s*</.test(text) && text.includes('<MPD') ? 'dash' : streamFormat(url) === 'dash' ? 'dash'
    : (text.includes('#EXTM3U') || streamFormat(url) === 'hls') ? 'hls' : streamFormat(url);
  const name = nameFromUrl(url);

  if (sniffed === 'dash') {
    const mpd = parseMpd(text, url);
    const variants = mpd.representations.map((r, i) => ({
      id: r.id || `v${i}`,
      bandwidth: r.bandwidth,
      resolution: r.width && r.height ? `${r.width}x${r.height}` : '',
      frameRate: r.frameRate || '',
      codecs: r.codecs || '',
      audio: mpd.audioRepresentations.length
        ? (mpd.audioRepresentations[0].codecs || mpd.audioRepresentations[0].audioSamplingRate || 'audio')
        : '',
      mimeType: r.mimeType,
      segments: r.segments.length,
    }));
    return {
      format: 'dash',
      live: mpd.live,
      name,
      variants,
      duration: mpd.durationSec || undefined,
    };
  }

  // HLS
  if (isMasterPlaylist(text)) {
    const master = parseMaster(text, url);
    const variants = master.variants.map((v, i) => ({
      id: v.id || `v${i}`,
      bandwidth: v.bandwidth,
      resolution: v.resolution,
      frameRate: v.frameRate || undefined,
      codecs: v.codecs,
      audio: v.audio
        ? (master.audioTracks.find(a => a.groupId === v.audio)?.name || v.audio)
        : (master.audioTracks.length ? master.audioTracks[0].name : undefined),
    }));
    return { format: 'hls', live: false, name, variants };
  }

  const media = parseMedia(text, url);
  return {
    format: 'hls',
    live: !media.endList,
    name,
    duration: media.duration || undefined,
    variants: [{
      id: 'default',
      bandwidth: 0,
      resolution: '',
      codecs: '',
      audio: '',
      segments: media.segments.length,
    }],
  };
}
