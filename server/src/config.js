import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
// Docker/headless overrides: all paths & listen settings can come from env.
// Defaults are unchanged (desktop layout under the repo root).
const platformBin = path.join(ROOT, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch);
export const BIN_DIR = path.resolve(process.env.FOXDOWN_BIN_DIR || process.env.KIMI_BIN_DIR
  || (fs.existsSync(platformBin) ? platformBin : path.join(ROOT, 'bin')));
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.join(ROOT, 'downloads');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

for (const d of [DATA_DIR, DOWNLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

export const ARIA2_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
const MEDIA_DIR = process.platform === 'darwin' && fs.existsSync(path.join(BIN_DIR, 'media/bin'))
  ? path.join(BIN_DIR, 'media/bin') : BIN_DIR;
export const FFMPEG_BIN = path.join(MEDIA_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
export const FFPROBE_BIN = path.join(MEDIA_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
// Optional external stream engine (drop N_m3u8DL-RE.exe into bin/ to enable full MSS/DRM support)
export const NM3U8_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE');

export const ARIA2_RPC_PORT = 16800;
export const API_PORT = Number(process.env.FOXDOWN_PORT || process.env.KIMI_PORT || process.env.API_PORT) || 16801;
// 127.0.0.1 by default (desktop); containers set KIMI_HOST=0.0.0.0
export const API_HOST = process.env.FOXDOWN_HOST || process.env.KIMI_HOST || process.env.API_HOST || '127.0.0.1';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  // aria2 core
  downloadDir: DOWNLOAD_DIR,
  maxConcurrentDownloads: 5,
  maxConnectionPerServer: 16,   // Motrix-built aria2 allows up to 64
  split: 16,
  minSplitSize: '1M',
  maxOverallDownloadLimit: 0,   // bytes/s, 0 = unlimited
  maxOverallUploadLimit: 0,
  continueDownloads: true,
  fileAllocation: 'none',
  diskCache: '64M',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  checkCertificate: true,
  // 代理（aria2 --all-proxy 系，参考 aria2 原生选项）
  proxyEnabled: false,
  proxyServer: '',          // 如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
  proxyUser: '',
  proxyPasswd: '',
  noProxy: '',              // 逗号分隔的不走代理的域名/IP
  // bittorrent
  enableDht: true,
  btEnableLpd: true,
  btEnablePex: true,          // PEX（Peer Exchange）去中心化节点交换
  btMaxPeers: 128,
  btTracker: '',                // comma separated; auto-filled by tracker update
  btTrackerSource: 'https://fastly.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
  btTrackerAutoUpdate: true,
  seedRatio: 1.0,
  seedTime: 0,                  // minutes, 0 = unlimited
  followTorrent: true,
  listenPort: 51413,
  upnpEnabled: false,         // UPnP/NAT-PMP 自动端口映射（Motrix nat-api 方案）
  // RPC / 远程访问（aria2 JSON-RPC，供 AriaNG 等生态工具接入）
  rpcPort: 16800,
  rpcListenAll: false,        // false = 仅 127.0.0.1；true = 监听全网卡（远程访问需配 token）
  // stream engine
  streamThreadCount: 8,
  streamRetryCount: 5,
  streamTimeoutMs: 20000,
  streamMuxAfterDownload: true, // remux TS -> MP4 via ffmpeg when possible
  streamLiveRecordLimitMin: 0,  // 0 = until end
  savePattern: '<SaveName>',    // N_m3u8DL --save-pattern 变量模板
  preferExternalStreamEngine: true, // use N_m3u8DL-RE.exe when present
  // 后处理（Gopeed webhook/脚本/自动解压）
  webhookUrl: '',               // 任务完成/失败时 POST JSON
  postScript: '',               // 完成后执行的本地脚本路径（.bat/.ps1/.sh）
  autoExtract: false,           // 完成后自动解压 zip/tar/tgz（Windows 自带 tar）
  // 限速预设（Motrix 多档方案；bytes/s，0=不限）
  speedProfiles: [
    { name: '全速模式', down: 0, up: 0 },
    { name: '办公模式', down: 2097152, up: 1048576 },
    { name: '夜间模式', down: 10485760, up: 5242880 },
  ],
  activeSpeedProfile: -1,       // -1 = 不启用预设
  // app
  apiToken: '',                 // empty = no auth (localhost only)
  theme: 'auto',
  locale: 'zh-CN',
  // rpc secret is generated once and persisted
  rpcSecret: '',
};

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  const merged = { ...DEFAULT_SETTINGS, ...s };
  // Environment variables take precedence over settings.json (headless/Docker)
  if (process.env.API_TOKEN) merged.apiToken = process.env.API_TOKEN;
  if (process.env.DOWNLOAD_DIR) merged.downloadDir = DOWNLOAD_DIR;
  if (!merged.rpcSecret) merged.rpcSecret = crypto.randomBytes(16).toString('hex');
  saveSettings(merged);
  return merged;
}

export function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function hasExternalStreamEngine() {
  try { fs.accessSync(NM3U8_BIN, fs.constants.X_OK); return true; } catch { return false; }
}

export function hasFfmpeg() {
  try { fs.accessSync(FFMPEG_BIN, fs.constants.X_OK); return true; } catch { return false; }
}
