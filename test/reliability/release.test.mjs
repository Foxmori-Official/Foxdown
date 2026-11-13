import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../tools/prepare-release.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxdown-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  for (const file of ['package.json', 'server/package.json', 'web/package.json', 'extension/manifest.json']) write(file, { version: '0.0.1' });
  for (const file of ['package-lock.json', 'server/package-lock.json', 'web/package-lock.json']) write(file, { version: '0.0.1', packages: { '': { version: '0.0.1' } } });
  write('docs/releases/v0.0.1.md', '## 简体中文\n\n首个版本。\n');
  const output = path.join(root, 'outputs');
  const run = overrides => spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
      RELEASE_INPUT: '', HEAD_COMMIT_MESSAGE: 'fix: ordinary change', GITHUB_OUTPUT: output, ...overrides },
  });
  return { root, write, output, run };
}

test('ordinary main changes do not create a release', t => {
  const f = fixture(t); const result = f.run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(f.output, 'utf8'), /^release_tag=\n/);
});

test('release commits and version tags select the matching Chinese-only release', t => {
  const f = fixture(t);
  for (const env of [{ HEAD_COMMIT_MESSAGE: 'release: v0.0.1\n\n构建首个版本。' }, { GITHUB_REF: 'refs/tags/v0.0.1' }, { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_INPUT: 'v0.0.1' }]) {
    const result = f.run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(f.output, 'utf8'), /release_tag=v0\.0\.1\n/);
  }
});

test('a mismatched release tag or package version blocks the release', t => {
  const f = fixture(t);
  assert.notEqual(f.run({ GITHUB_REF: 'refs/tags/v0.0.2' }).status, 0);
  f.write('extension/manifest.json', { version: '0.0.2' });
  assert.notEqual(f.run({ HEAD_COMMIT_MESSAGE: 'release: v0.0.1' }).status, 0);
});

test('Chinese-only release notes also support Windows line endings', t => {
  const f = fixture(t);
  f.write('docs/releases/v0.0.1.md', '\uFEFF## 简体中文\r\n\r\n首个版本。\r\n');
  const result = f.run({ HEAD_COMMIT_MESSAGE: 'release: v0.0.1' });
  assert.equal(result.status, 0, result.stderr);
});

test('foreign branches and English-first release notes cannot be released manually', t => {
  const f = fixture(t);
  assert.notEqual(f.run({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/other', RELEASE_INPUT: 'v0.0.1' }).status, 0);
  f.write('docs/releases/v0.0.1.md', '## English\n\nInitial release.\n\n## 简体中文\n\n首个版本。\n');
  assert.notEqual(f.run({ HEAD_COMMIT_MESSAGE: 'release: v0.0.1' }).status, 0);
});
