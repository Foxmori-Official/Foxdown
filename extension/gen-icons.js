// Foxmori product icons. Canonical artwork: icons/icon.svg.
// From the repository root after npm install: node extension/gen-icons.js
// sharp is a development dependency; generated icons have no runtime dependency.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const source = await fs.readFile(path.join(__dirname, 'icons/icon.svg'));
  for (const size of [16, 32, 48, 128]) {
    await sharp(source, { density: 384 }).resize(size, size).png({ palette: true, colours: 128, effort: 10 })
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
    await sharp(source, { density: 384 }).resize(size, size).png({ palette: true, colours: 128, effort: 10 }).toFile(output);
  }
  console.log('Foxmori Foxdown icons generated (16/32/48/128/256/512, Web and store).');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
