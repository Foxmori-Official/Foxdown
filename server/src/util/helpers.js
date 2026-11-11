import crypto from 'node:crypto';

export const genId = () => crypto.randomBytes(8).toString('hex');

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatSpeed(n) { return `${formatBytes(n)}/s`; }

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function sanitizeFilename(name) {
  return (name || 'download')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'download';
}

/** Guess a filename from a URL path or Content-Disposition header. */
export function guessFilename(url, contentDisposition) {
  if (contentDisposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(contentDisposition);
    if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {} }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(contentDisposition);
    if (plain) return plain[1].trim();
  }
  try {
    const p = new URL(url).pathname;
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    if (base && base.includes('.')) return base;
  } catch {}
  return '';
}

export function isMagnet(u) { return /^magnet:\?/i.test(u || ''); }
export function isTorrentUrl(u) { return /\.torrent(\?|#|$)/i.test(u || ''); }
export function isStreamUrl(u) { return /\.(m3u8|mpd|ism)(\?|#|\/manifest|$)/i.test(u || '') || /\/manifest(\.mpd)?(\?|#|$)/i.test(u || ''); }
export function streamFormat(u) {
  if (/\.m3u8(\?|#|$)/i.test(u || '')) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(u || '')) return 'dash';
  if (/\.ism/i.test(u || '')) return 'mss';
  return 'unknown';
}
