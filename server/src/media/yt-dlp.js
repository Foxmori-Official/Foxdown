import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { YTDLP_BIN, FFMPEG_BIN, hasFfmpeg } from '../config.js';
import { sanitizeFilename } from '../util/helpers.js';

const run = promisify(execFile);
const active = new Map();
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'flv', 'ogv', 'wmv', 'mpeg', 'mpg', 'ts']);

export function normalizeVideoUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

async function findYtDlp() {
  const file = process.env.FOXDOWN_YTDLP_PATH || YTDLP_BIN;
  if (!path.isAbsolute(file)) return null;
  try {
    if (!(await stat(file)).isFile()) return null;
    await access(file, constants.X_OK);
    return file;
  } catch { return null; }
}

function legacyXFormats(info) {
  const variants = new Map();
  for (const format of Array.isArray(info?.formats) ? info.formats.slice(0, 100) : []) {
    if (!format?.protocol) continue;
    const playlist = /^(?:m3u8|m3u8_native)$/.test(format.protocol);
    // A master manifest retains the audio renditions. A child's media URL
    // may be video-only. For direct files, reject explicitly split tracks.
    if (!playlist && (format.protocol !== 'https' || format.ext !== 'mp4' ||
        format.acodec === 'none' || format.vcodec === 'none')) continue;
    const url = playlist ? format.manifest_url : format.url;
    if (typeof url !== 'string' || url.length > 4096 || !/^https:\/\/video\.twimg\.com\//i.test(url)) continue;
    if (!(playlist ? /^[^?#]*\.m3u8(?:[?#]|$)/i : /^[^?#]*\.mp4(?:[?#]|$)/i).test(url)) continue;
    const bitrate = Number.isFinite(format.tbr) ? Math.round(format.tbr * 1000) : 0;
    if (!variants.has(url) || variants.get(url).bitrate < bitrate) variants.set(url, { url, bitrate });
  }
  return [...variants.values()];
}

function mediaHeaders(info, format) {
  const headers = {};
  for (const [name, value] of Object.entries({ ...info.http_headers, ...format.http_headers })) {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) continue;
    const key = name.toLowerCase();
    if (key === 'user-agent') headers[key] = value;
    if (key === 'referer') {
      const referer = normalizeVideoUrl(value);
      if (referer) headers[key] = referer;
    }
  }
  return headers;
}

function compareFormats(a, b) {
  return (a.width * a.height) - (b.width * b.height) ||
    Number(b.stream) - Number(a.stream) || a.bitrate - b.bitrate ||
    Number(a.type === 'MP4') - Number(b.type === 'MP4');
}

function pageVideo(info) {
  const choices = [];
  const manifests = new Map();
  const formats = Array.isArray(info?.formats) && info.formats.length ? info.formats : [info];
  for (const format of formats.slice(-300)) {
    if (!format || format.has_drm) continue;
    const url = normalizeVideoUrl(format.url);
    if (!url) continue;
    const ext = String(format.ext || '').toLowerCase();
    const video = format.vcodec !== 'none' && (Boolean(format.vcodec) || VIDEO_EXTENSIONS.has(ext));
    const audio = format.acodec !== 'none';
    const candidate = {
      url, width: Number(format.width) || 0, height: Number(format.height) || 0,
      bitrate: Number(format.tbr) || 0, stream: false, type: ext.toUpperCase(),
      headers: mediaHeaders(info, format), size: Number(format.filesize ?? format.filesize_approx) || 0,
    };
    const hls = /^(?:m3u8|m3u8_native)$/.test(format.protocol);
    const dash = format.protocol === 'http_dash_segments';
    if (hls || dash) {
      // Separate audio and video renditions can share a playable master URL.
      // Never hand a single video-only rendition to the download engine.
      const manifest = normalizeVideoUrl(format.manifest_url) || (hls && video && audio ? url : '');
      if (!manifest) continue;
      const prior = manifests.get(manifest);
      const stream = { ...candidate, url: manifest, type: hls ? 'HLS' : 'DASH', stream: true, size: 0 };
      const preferred = !prior || compareFormats(stream, prior.resource) > 0 ? stream : prior.resource;
      manifests.set(manifest, { resource: preferred, video: video || prior?.video, audio: audio || prior?.audio });
    } else if ((!format.protocol || /^(?:http|https)$/.test(format.protocol)) && VIDEO_EXTENSIONS.has(ext) && video && audio) {
      const title = sanitizeFilename(typeof info.title === 'string' && info.title.trim() ? info.title : String(info.id || 'video'));
      const suffix = `.${ext}`;
      const stem = title.toLowerCase().endsWith(suffix) ? title.slice(0, -suffix.length) : title;
      choices.push({ ...candidate, filename: `${stem.slice(0, 110)}.${ext}` });
    }
  }
  for (const { resource, video, audio } of manifests.values()) {
    if (video && audio) choices.push(resource);
  }
  return choices.sort((a, b) => compareFormats(b, a))[0];
}

export function pageVideoResources(entries) {
  const videos = new Map();
  for (const entry of entries) {
    const video = pageVideo(entry);
    if (video && !videos.has(video.url)) videos.set(video.url, video);
  }
  return [...videos.values()];
}

async function extractVideos(url, legacyX) {
  const executable = await findYtDlp();
  if (!executable) return { available: false, videos: [] };
  const ffmpeg = hasFfmpeg() ? ['--ffmpeg-location', path.dirname(FFMPEG_BIN)] : [];
  // In the desktop service ELECTRON_RUN_AS_NODE is inherited by the resolver.
  const extractor = legacyX ? ['--use-extractors', 'Twitter'] : ['--js-runtimes', `node:${process.execPath}`];
  const { stdout } = await run(executable, [
    '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-remote-components', '--no-js-runtimes', ...extractor,
    '--extractor-args', 'twitter:api=syndication', '--no-playlist', '--playlist-end', '8',
    '--socket-timeout', '6', '--retries', '0', '--extractor-retries', '0',
    '--no-check-formats', '--no-warnings', '--dump-single-json', '--skip-download', ...ffmpeg,
    '--', url,
  ], { timeout: 28000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const result = JSON.parse(stdout);
  const entries = Array.isArray(result?.entries) ? result.entries.slice(0, 8) : [result];
  const videos = legacyX ? entries.map(legacyXFormats).filter(formats => formats.length) : pageVideoResources(entries);
  return { available: true, videos };
}

function resolveVideos(url, legacyX = false) {
  const key = `${legacyX ? 'x:' : ''}${url}`;
  if (active.has(key)) return active.get(key);
  if (active.size >= 2) return null;
  const work = extractVideos(url, legacyX).finally(() => active.delete(key));
  active.set(key, work);
  return work;
}

export function resolvePageVideos(input) {
  const url = normalizeVideoUrl(input);
  if (!url) throw new TypeError('Invalid video page URL');
  return resolveVideos(url);
}

export function resolveXVideos(id) {
  if (typeof id !== 'string' || !/^\d{1,22}$/.test(id)) throw new TypeError('Invalid X post ID');
  return resolveVideos(`https://x.com/i/web/status/${id}`, true);
}
