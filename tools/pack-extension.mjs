#!/usr/bin/env node
// pack-extension.mjs — pure-Node ZIP packer (no third-party deps) for the Chrome
// extension in extension/. Hand-builds ZIP (Local File Header + Central
// Directory + EOCD) using the STORE method, then self-validates the archive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const OUT_ZIP = path.join(ROOT, 'Foxdown-extension.zip');

// ---- inclusion / exclusion rules -------------------------------------------
const REQUIRED = [
  'settings.js', 'options-dashboard.js', 'options-updates.mjs', 'release-updates.mjs',
  'manifest.json',
  'background.js', 'content.js', 'i18n.js', 'lib.js',
  'popup.html', 'popup.js', 'options.html', 'options.js',
  'onboarding.html', 'onboarding.js', 'onboarding.css', 'theme.css', 'connection.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  '_locales/en/messages.json', '_locales/zh_CN/messages.json',
  'vendor/hls.min.js',
  'PRIVACY.md',
];
const EXCLUDE_BASENAMES = new Set(['icon-source.png', 'gen-icons.js', '.DS_Store', 'Thumbs.db', '.env']);
const EXCLUDE_DIRS = new Set(['store', 'node_modules', '.git']);
const EXCLUDE_EXT = new Set(['.ts', '.map']);

function collect(dir, rel = '', out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      collect(path.join(dir, ent.name), r, out);
    } else if (ent.isFile()) {
      if (EXCLUDE_BASENAMES.has(ent.name)) continue;
      if (EXCLUDE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      out.push(r);
    }
  }
  return out;
}

// ---- CRC-32 (manual, bulletproof) -------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// ---- ZIP writer (STORE, no compression) --------------------------------------
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(mtime);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0x0800, 6);       // flags: bit 11 = UTF-8 filename
    lfh.writeUInt16LE(0, 8);            // method 0 = STORE
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra field length
    locals.push(lfh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // central directory signature
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0x0800, 8);        // flags
    cd.writeUInt16LE(0, 10);            // method STORE
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra length
    cd.writeUInt16LE(0, 32);            // comment length
    cd.writeUInt16LE(0, 34);            // disk number start
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(0, 38);            // external attrs
    cd.writeUInt32LE(offset, 42);       // local header offset
    centrals.push(Buffer.concat([cd, nameBuf]));

    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // EOCD signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // CD offset
  eocd.writeUInt16LE(0, 20);            // comment length
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---- validation helpers -------------------------------------------------------
function stripStrings(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"/gs, '""');
}
function validateJsonStrict(text, label) {
  JSON.parse(text); // strict: throws on comments & trailing commas
  const stripped = stripStrings(text);
  const hasComment = /\/\/|\/\*/.test(stripped);
  const hasTrailingComma = /,\s*[}\]]/.test(stripped);
  if (hasComment) throw new Error(`${label}: contains comments`);
  if (hasTrailingComma) throw new Error(`${label}: contains trailing comma`);
}

// parse our own ZIP back via Local File Header list
function listLocalFileHeaders(buf) {
  const names = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    names.push({ name, method, size: compSize });
    p += 30 + nameLen + extraLen + compSize;
  }
  return names;
}

// ---- main ---------------------------------------------------------------------
// manifest.json first (convention + Chrome Web Store expects it at root),
// then everything else sorted.
const relFiles = collect(EXT_DIR).sort((a, b) =>
  a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a < b ? -1 : a > b ? 1 : 0);
const missing = REQUIRED.filter(r => !relFiles.includes(r));
if (missing.length) {
  console.error('MISSING required files:', missing.join(', '));
  process.exit(1);
}

const files = relFiles.map(rel => ({
  name: rel,
  data: fs.readFileSync(path.join(EXT_DIR, rel)),
  mtime: fs.statSync(path.join(EXT_DIR, rel)).mtime,
}));

const zip = buildZip(files);
fs.writeFileSync(OUT_ZIP, zip);

// ---- self-validation ----------------------------------------------------------
const errors = [];
const lfhList = listLocalFileHeaders(zip);
const manifestAtRoot = lfhList.length > 0 && lfhList[0].name === 'manifest.json'
  && lfhList.every(e => !e.name.endsWith('/manifest.json') || e.name === 'manifest.json');
if (!manifestAtRoot) errors.push('ZIP root check: manifest.json missing at archive root');

const manifestText = files.find(f => f.name === 'manifest.json').data.toString('utf8');
let manifestJsonOk = true;
try { validateJsonStrict(manifestText, 'manifest.json'); }
catch (e) { manifestJsonOk = false; errors.push(`manifest.json invalid: ${e.message}`); }

const msgFiles = files.filter(f => /_locales\/[^/]+\/messages\.json$/.test(f.name));
for (const m of msgFiles) {
  try { validateJsonStrict(m.data.toString('utf8'), m.name); }
  catch (e) { errors.push(`${m.name} invalid: ${e.message}`); }
}

const totalUncompressed = files.reduce((s, f) => s + f.data.length, 0);
console.log(`ZIP: ${OUT_ZIP}`);
console.log(`ZIP size: ${zip.length} bytes (${(zip.length / 1024).toFixed(1)} KiB), files: ${lfhList.length}, uncompressed total: ${totalUncompressed} bytes`);
console.log(`manifest.json at ZIP root: ${manifestAtRoot ? 'YES' : 'NO'}`);
console.log(`manifest.json JSON valid, no comments, no trailing commas: ${manifestJsonOk ? 'YES' : 'NO'}`);
console.log(`messages.json validated: ${msgFiles.length}/2 ${msgFiles.length === 2 ? 'OK' : 'COUNT MISMATCH'}`);
if (errors.length) {
  console.error('VALIDATION FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
