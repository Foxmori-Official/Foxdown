// 本地 HLS 测试服务器：静态服务 test/fixtures + 模拟直播 /live.m3u8
// 用法: node test/hls-server.mjs [port=8686]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8686);
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.bin': 'application/octet-stream', '.mpd': 'application/dash+xml' };

// 直播模拟：复用 v360 真实分片，窗口每 2s 长一片，8 片后 ENDLIST
const liveSegs = fs.readdirSync(FIX).filter(f => /^v360_\d+\.ts$/.test(f)).sort();
const t0 = Date.now();
const LIVE_TOTAL = Math.min(8, liveSegs.length);
const livePlaylist = () => {
  const n = Math.min(Math.floor((Date.now() - t0) / 2000) + 2, LIVE_TOTAL);
  const end = n >= LIVE_TOTAL;
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n` +
    Array.from({ length: n }, (_, i) => `#EXTINF:2.0,\n${liveSegs[i]}`).join('\n') +
    (end ? '\n#EXT-X-ENDLIST\n' : '\n');
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (u.pathname === '/live.m3u8') { res.setHeader('Content-Type', MIME['.m3u8']); return res.end(livePlaylist()); }
  const p = path.join(FIX, path.normalize(u.pathname).replace(/^([/\\])+/, ''));
  if (!p.startsWith(FIX) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`[hls-test] http://127.0.0.1:${PORT}\n  VOD: /v360.m3u8 /v720.m3u8  master: /master.m3u8  加密: /enc.m3u8  直播: /live.m3u8`));
