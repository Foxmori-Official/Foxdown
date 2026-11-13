// Foxmori product icons. Canonical artwork: icons/icon-source.png.
// From the repository root after npm install: node extension/gen-icons.js
// sharp is a development dependency; generated icons have no runtime dependency.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const source = await fs.readFile(path.join(__dirname, 'icons/icon-source.png'));
  for (const size of [16, 32, 48, 128]) {
    await sharp(source).resize(size, size).png({ compressionLevel: 9 })
      .toFile(path.join(__dirname, `icons/icon${size}.png`));
  }
  const root = path.join(__dirname, '..');
  for (const [size, file] of [
    [512, 'web/public/logo.png'],
    [64, 'web/public/favicon.png'],
    [256, 'extension/store/icon256.png'],
  ]) {
    const output = path.join(root, file);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toFile(output);
  }
  // macOS applies its own icon shape. Supply an opaque 1024px background so
  // transparent margins do not become an extra system-provided light plate.
  await sharp(source).resize(1024, 1024).flatten({ background: '#234b38' })
    .png({ compressionLevel: 9 }).toFile(path.join(root, 'web/public/icon-mac.png'));
  console.log('Foxmori Foxdown icons generated (16–1024px, Web, store and macOS).');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
