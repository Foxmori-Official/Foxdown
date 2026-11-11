// Build-time engine preparation. Desktop installers include the prepared directory.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const motrix = 'https://raw.githubusercontent.com/agalwood/Motrix/a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a/extra';
const aria2Hashes = {
  'darwin-arm64': '1527c4d071c16c1266880e93750e385cdd4e9d2a950d7f56cb5a21125e3bd311',
  'darwin-x64': 'be98b2260162b4b75c6a271a496c3fc96080e37561719381d9d883fbf7d25455',
  'win32-x64': '098a065ab71f639bf7048e790c870756fd6e83de9cc678915bbd07077d473fa2',
};
const macMediaIntegrity = {
  arm64: 'SSFe4diu+OZjdzF4M+J3Ip1vjR53gVUdawpHnZ5N1+5Sab+VfeJ8rxnEOUe7JfGuv1oSkBhyxY3gDEOQ5010Xg==',
  x64: 'rV0gxgpjkTKABk2h6UI9KmeU6uoXcGZ1GZwNd8zlk7vM9yLEgksMzt2/hE4QRTLty3ydUVDGyjd5TM6oTumw4w==',
};
const winMedia = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const winHashes = {
  ffmpeg: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  ffprobe: 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
};

function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function download(url) {
  const request = async source => {
    const response = await fetch(source, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${source}`);
    return Buffer.from(await response.arrayBuffer());
  };
  return request(url).catch(() => request(url + '?retry=' + Date.now()));
}

async function verifiedBinary(file, url, sha256, compressed = false) {
  const expectedFileHash = compressed ? null : sha256;
  if (expectedFileHash) {
    const existing = await readFile(file).catch(() => null);
    if (existing && digest(existing) === expectedFileHash) return;
  }
  const bytes = await download(url);
  if (digest(bytes) !== sha256) throw new Error(`SHA-256 mismatch for ${url}`);
  await writeFile(file, compressed ? gunzipSync(bytes) : bytes, { mode: 0o755 });
}

export async function missingEngines(binDir) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const mediaDir = process.platform === 'darwin' ? path.join(binDir, 'media/bin') : binDir;
  const files = [path.join(binDir, 'aria2c' + suffix), ...['ffmpeg', 'ffprobe'].map(name => path.join(mediaDir, name + suffix))];
  const exists = await Promise.all(files.map(file => access(file, constants.X_OK).then(() => true, () => false)));
  return files.filter((_, index) => !exists[index]);
}

async function prepare(binDir, arch) {
  const platform = process.platform;
  const engineArch = platform === 'win32' && arch === 'arm64' ? 'x64' : arch;
  const target = `${platform}-${engineArch}`;
  const aria2Hash = aria2Hashes[target];
  if (!aria2Hash) throw new Error(`Engine preparation does not support ${platform}/${arch}`);
  await mkdir(binDir, { recursive: true });
  const suffix = platform === 'win32' ? '.exe' : '';
  console.log(`Preparing bundled engines for ${platform}/${arch}`);
  await verifiedBinary(path.join(binDir, 'aria2c' + suffix), `${motrix}/${platform}/${engineArch}/engine/aria2c${suffix}`, aria2Hash);

  if (platform === 'darwin') {
    const version = '9.0.1-1';
    const name = 'ffmpeg-macos-lgpl-' + arch;
    const url = `https://registry.npmjs.org/@dfloresc/${name}/-/${name}-${version}.tgz`;
    const bytes = await download(url);
    if (digest(bytes, 'sha512', 'base64') !== macMediaIntegrity[arch]) throw new Error('macOS FFmpeg integrity mismatch');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'foxdown-media-'));
    try {
      const archive = path.join(temporary, 'media.tgz');
      await writeFile(archive, bytes);
      execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'pipe' });
      const source = path.join(temporary, 'package');
      const dest = path.join(binDir, 'media');
      await mkdir(dest, { recursive: true });
      for (const entry of ['bin', 'lib', 'LICENSES', 'BUILDINFO.txt']) {
        await cp(path.join(source, entry), path.join(dest, entry), { recursive: true });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    for (const name of ['ffmpeg', 'ffprobe']) {
      await verifiedBinary(path.join(binDir, name + suffix), `${winMedia}/${name}-win32-x64.gz`, winHashes[name], true);
    }
  }

  const licenses = path.join(binDir, 'licenses');
  await mkdir(licenses, { recursive: true });
  const notices = [
    ['aria2-COPYING.txt', 'https://raw.githubusercontent.com/aria2/aria2/release-1.36.0/COPYING'],
  ];
  if (platform === 'win32') {
    for (const name of ['LICENSE', 'README']) {
      const bytes = await download(`${winMedia}/win32-x64.${name}.gz`);
      await writeFile(path.join(licenses, 'ffmpeg-' + name + '.txt'), gunzipSync(bytes));
    }
  }
  for (const [name, url] of notices) await writeFile(path.join(licenses, name), await download(url));
  await cp(new URL('../docs/third-party.md', import.meta.url), path.join(licenses, 'THIRD-PARTY.md'));
  await writeFile(path.join(binDir, 'target.json'), JSON.stringify({
    platform, arch, engineArch, aria2Source: motrix, macFFmpeg: platform === 'darwin' ? '9.0.1-1 LGPL' : null,
    winFFmpeg: platform === 'win32' ? 'ffmpeg-static b6.1.1' : null,
  }, null, 2) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const arch = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7) || process.arch;
  const folder = (process.platform === 'darwin' ? 'mac' : 'win') + '-' + arch;
  const dir = process.env.FOXDOWN_BIN_DIR || process.env.KIMI_BIN_DIR || fileURLToPath(new URL('../bin/' + folder + '/', import.meta.url));
  prepare(dir, arch).then(() => console.log(`Bundled engines ready in ${dir}`)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
