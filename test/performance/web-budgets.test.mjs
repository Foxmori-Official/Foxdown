// Run `npm run test:web-build`: assertions apply to production build artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const manifestFile = path.join(root, '.vite/manifest.json');
assert.ok(fs.existsSync(manifestFile), 'Build first: npm run test:web-build');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const entryKey = Object.keys(manifest).find(key => manifest[key].isEntry);
const closure = new Set();
function collect(key) {
  if (closure.has(key)) return;
  closure.add(key);
  for (const dependency of manifest[key].imports || []) collect(dependency);
}
collect(entryKey);
const initialFiles = new Set();
for (const key of closure) {
  initialFiles.add(manifest[key].file);
  for (const css of manifest[key].css || []) initialFiles.add(css);
}
const size = ext => [...initialFiles].filter(file => file.endsWith(ext)).reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
const gzip = ext => [...initialFiles].filter(file => file.endsWith(ext)).reduce((sum, file) => sum + gzipSync(fs.readFileSync(path.join(root, file))).length, 0);

test('initial static dependency graph stays inside raw and gzip budgets', t => {
  const metrics = { initialJs: size('.js'), initialJsGzip: gzip('.js'), initialCss: size('.css'), initialCssGzip: gzip('.css') };
  t.diagnostic(JSON.stringify(metrics));
  assert.ok(metrics.initialJs < 500000, `Initial JS exceeds 500KB: ${metrics.initialJs}`);
  assert.ok(metrics.initialJsGzip < 175000, `Initial JS gzip exceeds 175KB: ${metrics.initialJsGzip}`);
  assert.ok(metrics.initialCss < 100000, `Initial CSS exceeds 100KB: ${metrics.initialCss}`);
  assert.ok(metrics.initialCssGzip < 17000, `Initial CSS gzip exceeds 17KB: ${metrics.initialCssGzip}`);
});

test('settings, new-task dialog and task rows remain outside the static initial graph', () => {
  for (const suffix of ['Settings.vue', 'NewTaskDialog.vue', 'TaskRow.vue']) {
    const key = Object.keys(manifest).find(key => key.endsWith(suffix));
    assert.ok(key, `Missing dynamic chunk for ${suffix}`);
    assert.ok(!closure.has(key), `${suffix} was accidentally statically imported`);
    assert.ok(manifest[key].isDynamicEntry, `${suffix} must be a dynamic entry`);
  }
});

test('every generated import and stylesheet referenced by the manifest exists', () => {
  for (const [key, chunk] of Object.entries(manifest)) {
    assert.ok(fs.existsSync(path.join(root, chunk.file)), `missing ${chunk.file}`);
    for (const css of chunk.css || []) assert.ok(fs.existsSync(path.join(root, css)), `missing ${css}`);
    for (const dependency of [...(chunk.imports || []), ...(chunk.dynamicImports || [])]) {
      assert.ok(manifest[dependency], `${key}: missing manifest dependency ${dependency}`);
    }
  }
});
