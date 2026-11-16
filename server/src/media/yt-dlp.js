import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BIN_DIR, FFMPEG_BIN, hasFfmpeg } from '../config.js';

const run = promisify(execFile);
const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const active = new Map();

async function findYtDlp() {
  const override = process.env.FOXDOWN_YTDLP_PATH;
  const directories = (process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  if (process.platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin');
  if (process.platform !== 'win32') directories.push(path.join(os.homedir(), '.local', 'bin'));
  const paths = [path.join(BIN_DIR, binaryName), ...directories.map(dir => path.join(dir, binaryName))];
  for (const file of override ? [override] : new Set(paths)) {
    if (!path.isAbsolute(file)) continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

function videoFormats(info) {
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

async function extractXVideos(id) {
  const executable = await findYtDlp();
  if (!executable) return { available: false, videos: [] };
  const ffmpeg = hasFfmpeg() ? ['--ffmpeg-location', path.dirname(FFMPEG_BIN)] : [];
  const { stdout } = await run(executable, [
    '--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-remote-components', '--no-js-runtimes',
    '--use-extractors', 'Twitter', '--extractor-args', 'twitter:api=syndication',
    '--socket-timeout', '6', '--retries', '0', '--extractor-retries', '0',
    '--no-check-formats', '--no-warnings', '--dump-single-json', '--skip-download', ...ffmpeg,
    '--', `https://x.com/i/web/status/${id}`,
  ], { timeout: 28000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const result = JSON.parse(stdout);
  const entries = Array.isArray(result?.entries) ? result.entries.slice(0, 8) : [result];
  return { available: true, videos: entries.map(videoFormats).filter(formats => formats.length > 0) };
}

export function resolveXVideos(id) {
  if (typeof id !== 'string' || !/^\d{1,22}$/.test(id)) throw new TypeError('Invalid X post ID');
  if (active.has(id)) return active.get(id);
  if (active.size >= 2) return null;
  const work = extractXVideos(id).finally(() => active.delete(id));
  active.set(id, work);
  return work;
}
