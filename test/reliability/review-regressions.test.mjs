import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderNameTemplate } from '../../server/src/util/naming.js';
import { HookRunner } from '../../server/src/hooks/index.js';
import { isolateServer } from '../helpers/server-fixture.mjs';

test('desktop directory choices survive reload while an explicit environment override still wins', async t => {
  const root = isolateServer(t);
  const previousDefault = process.env.FOXDOWN_DEFAULT_DOWNLOAD_DIR;
  t.after(() => {
    if (previousDefault === undefined) delete process.env.FOXDOWN_DEFAULT_DOWNLOAD_DIR;
    else process.env.FOXDOWN_DEFAULT_DOWNLOAD_DIR = previousDefault;
  });
  delete process.env.DOWNLOAD_DIR;
  process.env.FOXDOWN_DEFAULT_DOWNLOAD_DIR = path.join(root, 'default');
  const { loadSettings, saveSettings } = await import('../../server/src/config.js');
  const settings = loadSettings();
  assert.equal(settings.downloadDir, path.join(root, 'default'));
  settings.downloadDir = path.join(root, 'chosen');
  saveSettings(settings);
  assert.equal(loadSettings().downloadDir, path.join(root, 'chosen'));
  const settingsModule = new URL('../../server/src/config.js', import.meta.url).href;
  const chosen = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {loadSettings} from ${JSON.stringify(settingsModule)}; console.log(loadSettings().downloadDir);`,
  ], { env: { ...process.env, DOWNLOAD_DIR: path.join(root, 'override') }, encoding: 'utf8' }).trim();
  assert.equal(chosen, path.join(root, 'override'));
});

test('shared filename variables accept all three syntaxes without a leftover dollar sign', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(readFileSync(new URL('../../extension/lib.js', import.meta.url), 'utf8') +
    '\n;globalThis.render = renderFileNameTemplate;', context);
  for (const template of ['<SaveName>_<Host>_<Date>', '{SaveName}_{Host}_{Date}', '${fileName}_${host}_${date}']) {
    const desktop = renderNameTemplate(template, { SaveName: 'sample', Host: 'example.invalid', Date: '20261113' });
    const extension = context.render(template, { url: 'https://example.invalid/sample.mp4', now: new Date(2026, 10, 13).getTime() });
    assert.equal(desktop, 'sample_example.invalid_20261113');
    assert.equal(extension, desktop);
  }
});

test('post-processing scripts receive FOXDOWN task variables', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxdown-hook-test-'));
  try {
    const output = path.join(root, 'environment.json');
    const script = path.join(root, 'capture.mjs');
    await fs.writeFile(script, `#!${process.execPath}
import fs from 'node:fs';
const entries = Object.entries(process.env).filter(([key]) => /^FOXDOWN_/.test(key));
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(Object.fromEntries(entries)));
`, { mode: 0o755 });
    await new HookRunner({ postScript: script })._script('complete', {
      id: 'fixture-task', name: 'fixture download', files: [{ path: '/fixture/file.zip' }],
    });
    const env = JSON.parse(await fs.readFile(output, 'utf8'));
    for (const [key, value] of Object.entries({
      EVENT: 'complete', TASK_ID: 'fixture-task', TASK_NAME: 'fixture download', FILE: '/fixture/file.zip', FILE_COUNT: '1',
    })) {
      assert.equal(env['FOXDOWN_' + key], value);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
