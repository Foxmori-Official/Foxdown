import fs from 'node:fs';
import path from 'node:path';

const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const packages = ['package.json', 'server/package.json', 'web/package.json', 'extension/manifest.json'];
const version = read(packages[0]).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('无效的软件版本号。');
for (const file of packages) {
  if (read(file).version !== version) throw new Error(`${file} 的版本号与主包不一致。`);
}
for (const file of ['package-lock.json', 'server/package-lock.json', 'web/package-lock.json']) {
  const lock = read(file);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error(`${file} 的版本号与主包不一致。`);
  }
}

let tag = '';
const event = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF || '';
if (event === 'push' && ref.startsWith('refs/tags/')) {
  tag = ref.slice('refs/tags/'.length);
} else if (event === 'workflow_dispatch') {
  tag = (process.env.RELEASE_INPUT || '').trim();
  if (tag && ref !== 'refs/heads/main') throw new Error('手动发布请使用 main 分支。');
} else if (event === 'push' && ref === 'refs/heads/main') {
  const title = (process.env.HEAD_COMMIT_MESSAGE || '').split('\n')[0];
  if (title.startsWith('release: ')) tag = title.slice('release: '.length).trim();
}
if (tag) {
  if (tag !== `v${version}`) throw new Error(`发布标签必须与包版本一致：v${version}。`);
  const notes = fs.readFileSync(path.resolve('docs/releases', `${tag}.md`), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!notes.startsWith('## 简体中文\n') || !notes.includes('\n## English\n')) {
    throw new Error('发布说明必须先提供简体中文，再提供英文。');
  }
}

console.log(`已核对软件版本：v${version}${tag ? '；本次生成 Release 草稿。' : '；本次仅构建。'}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${tag}\nversion=${version}\n`);
