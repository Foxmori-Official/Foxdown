// Shared resource classification for the browser worker and resource panel.
const MEDIA_SESSION_PREFIX = 'foxdown-media-';

function xPostId(url) {
  try {
    const page = new URL(url);
    if (page.protocol !== 'https:' || page.username || page.password || page.port ||
        !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(page.hostname)) return '';
    return page.pathname.match(/^\/(?:[a-z0-9_]+|i\/web)\/status\/(\d{1,22})(?:\/|$)/i)?.[1] || '';
  } catch { return ''; }
}

function xMediaFormat(url) {
  try {
    const source = new URL(url);
    if (source.origin !== 'https://video.twimg.com' || source.username || source.password) return null;
    const match = source.pathname.match(/^\/(ext_tw_video|amplify_video)\/(\d+)\/(?:pu\/)?(pl|vid|aud)\/(.+)$/);
    if (!match) return null;
    const [, collection, id, directory, path] = match;
    const key = `x-video:${collection}/${id}`;
    // A master playlist points to all tracks. Child playlists can be audio-only
    // or video-only, and must not be offered as a complete video.
    if (directory === 'pl' && /^[^/]+\.m3u8$/i.test(path)) {
      return { key, priority: 1 };
    }
    const file = directory === 'vid' && path.match(/^(?:(?:avc1|av01|hevc|hvc1)\/)?(?:(\d{1,5})x(\d{1,5})\/)?([^/]+)\.mp4$/i);
    if (file && !/^(?:init|segment|seg|chunk)(?:[._-]|$)/i.test(file[3])) {
      const dimensions = file[1] ? `${file[1]}×${file[2]}` : '';
      return { key, priority: 2, dimensions, pixels: Number(file[1] || 0) * Number(file[2] || 0) };
    }
    return { key, priority: 0 };
  } catch { return null; }
}

function isMediaFragment(url, contentType = '') {
  if (/^[^?#]*\.(?:m4s|cmfa|cmfv)(?:[?#]|$)/i.test(url) || /^(?:application|video|audio)\/m4s\b/i.test(contentType)) return true;
  return /^https:\/\/video\.twimg\.com\//i.test(url) && xMediaFormat(url)?.priority === 0;
}

function isTransportStream(url, contentType = '') {
  return /^[^?#]*\.ts(?:[?#]|$)/i.test(url) || /^video\/mp2t(?:;|$)/i.test(contentType);
}

function mediaKey(url) {
  return xMediaFormat(url)?.key || url;
}

function mediaFilename(url) {
  const source = new URL(url);
  const leaf = source.pathname.split('/').filter(Boolean).at(-1) || source.hostname;
  try { return decodeURIComponent(leaf); } catch { return leaf; }
}

function compareXMedia(a, b) {
  const af = xMediaFormat(a.url);
  const bf = xMediaFormat(b.url);
  return (af?.priority ?? (a.type === 'MP4' ? 2 : 1)) - (bf?.priority ?? (b.type === 'MP4' ? 2 : 1)) ||
    (af?.pixels || 0) - (bf?.pixels || 0) || (a.bitrate || 0) - (b.bitrate || 0);
}

function selectXVideos(videos, accepts = () => true) {
  const selected = new Map();
  for (const variants of Array.isArray(videos) ? videos.slice(0, 8) : []) {
    if (!Array.isArray(variants)) continue;
    let best;
    for (const variant of variants.slice(0, 32)) {
      const url = variant?.url;
      if (typeof url !== 'string' || url.length > 4096 || !/^https:\/\/video\.twimg\.com\//i.test(url)) continue;
      const hls = /^[^?#]*\.m3u8(?:[?#]|$)/i.test(url);
      if ((!hls && !/^[^?#]*\.mp4(?:[?#]|$)/i.test(url)) || isMediaFragment(url) || !accepts(url)) continue;
      const bitrate = Number(variant.bitrate);
      const candidate = { url, type: hls ? 'HLS' : 'MP4', bitrate: Number.isFinite(bitrate) ? bitrate : 0 };
      if (!best || compareXMedia(candidate, best) > 0) best = candidate;
    }
    if (!best) continue;
    const key = mediaKey(best.url);
    if (!selected.has(key) || compareXMedia(best, selected.get(key)) > 0) selected.set(key, best);
  }
  return [...selected.values()];
}

function xPostMedia(post, id, accepts) {
  if (post?.id_str !== id || !Array.isArray(post.mediaDetails)) return [];
  const videos = post.mediaDetails.slice(0, 8)
    .filter(item => ['video', 'animated_gif'].includes(item?.type))
    .map(item => item.video_info?.variants);
  return selectXVideos(videos, accepts);
}
