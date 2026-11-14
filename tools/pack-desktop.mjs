import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const target = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : '';
const args = process.argv.slice(2);
const expected = args.find(value => value === '--mac' || value === '--win') || '--' + target;
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch;
if (!target || expected !== '--' + target || !['arm64', 'x64'].includes(arch)) {
  throw new Error('Run packaging on macOS or Windows with the matching platform flag and --x64 or --arm64.');
}

execFileSync(process.execPath, ['tools/download-engines.mjs', '--arch=' + arch], { stdio: 'inherit' });
const { missingEngines } = await import('./download-engines.mjs');
const missing = await missingEngines(path.resolve('bin', target + '-' + arch));
if (missing.length) throw new Error('Bundled engines are incomplete: ' + missing.join(', '));

const cli = require.resolve('electron-builder/out/cli/cli.js');
const builderArgs = [cli, '--' + target, '--' + arch, '--publish', 'never'];
if (target === 'mac') {
  const sharp = require('sharp');
  const background = 'installer/mac/background';
  for (const [suffix, density] of [['', 72], ['@2x', 144]]) {
    await sharp(background + '.svg', { density }).png().toFile(background + suffix + '.png');
  }
}
execFileSync(process.execPath, builderArgs, { stdio: 'inherit' });

if (target === 'mac') {
  const { version } = require('../package.json');
  const output = path.resolve('dist-electron');
  const app = path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Foxdown.app');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  await fs.access(path.join(app, 'Contents', 'Resources', 'runtime', 'server', 'node_modules', 'express', 'package.json'));
  let verified = 0;
  for (const entry of await fs.readdir(app, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const handle = await fs.open(file, 'r');
    const header = Buffer.alloc(4);
    try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
    if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(header.toString('hex'))) continue;
    execFileSync('lipo', [file, '-verify_arch', arch === 'x64' ? 'x86_64' : arch], { stdio: 'pipe' });
    verified++;
  }
  console.log(`Verified ${verified} Mach-O components for ${arch}`);
  const dmg = path.join(output, `Foxdown-${version}-mac-${arch}.dmg`);
  execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit' });
}
