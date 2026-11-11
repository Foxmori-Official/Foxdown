// i18n 校验：9 个语言文件 key 集合与 zh_CN 完全一致（0 缺失 0 多余），
// 占位符 $1..$N 跨语言一致（防某语言漏译导致替换断裂），
// 且 HTML 的 data-i18n / data-i18n-ph 与 JS 的 i18n('...') 引用全部有对应 key。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const LOCALES = path.join(EXT, '_locales');
const dirs = fs.readdirSync(LOCALES).filter(d => fs.existsSync(path.join(LOCALES, d, 'messages.json'))).sort();

const ref = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh_CN', 'messages.json'), 'utf8'));
const refKeys = Object.keys(ref).sort();
let fail = 0;

console.log(`参照 zh_CN: ${refKeys.length} 个 key；发现语言: ${dirs.join(', ')}`);

// 教材 §4.1 长度断言：extName≤45 / extShortName≤12 / extDesc≤132 / actionTitle≤30
for (const d of dirs) {
  const j = JSON.parse(fs.readFileSync(path.join(LOCALES, d, 'messages.json'), 'utf8'));
  const checks = [
    ['extName', 45], ['extShortName', 12], ['extDesc', 132], ['actionTitle', 30],
  ];
  for (const [k, max] of checks) {
    const v = j[k]?.message;
    if (typeof v !== 'string' || !v) { console.error(`✗ ${d}.${k} 缺失`); fail++; }
    else if ([...v].length > max) { console.error(`✗ ${d}.${k} 超长 ${[...v].length}>${max}: ${v}`); fail++; }
  }
}
console.log('✓ 长度断言（extName≤45 / extShortName≤12 / extDesc≤132 / actionTitle≤30）已检查');
if (dirs.length !== 9) { console.error(`✗ 语言目录数 = ${dirs.length}，应为 9（Auto 由浏览器语言自动匹配）`); fail++; }

for (const d of dirs) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(path.join(LOCALES, d, 'messages.json'), 'utf8'));
  } catch (e) {
    console.error(`✗ ${d}: JSON 解析失败 ${e.message}`); fail++; continue;
  }
  const keys = Object.keys(obj).sort();
  const missing = refKeys.filter(k => !keys.includes(k));
  const extra = keys.filter(k => !refKeys.includes(k));
  const empty = keys.filter(k => !obj[k] || typeof obj[k].message !== 'string' || !obj[k].message.trim());
  if (missing.length || extra.length || empty.length) {
    fail++;
    console.error(`✗ ${d}: 缺失 ${missing.length} [${missing}] 多余 ${extra.length} [${extra}] 空消息 ${empty.length} [${empty}]`);
  } else {
    console.log(`✓ ${d}: ${keys.length} keys，0 缺失 0 多余`);
  }
}

// 占位符一致性：每 key 的 $N 占位符集合在 9 个语言必须与 zh_CN 相同
function placeholders(msg) {
  return [...String(msg).matchAll(/\$(\d+)/g)].map(m => '$' + m[1]).sort().join(',');
}
let phFail = 0;
for (const d of dirs) {
  const j = JSON.parse(fs.readFileSync(path.join(LOCALES, d, 'messages.json'), 'utf8'));
  for (const k of refKeys) {
    const want = placeholders(ref[k].message);
    const got = placeholders(j[k]?.message ?? '');
    if (want !== got) {
      console.error(`✗ ${d}.${k}: 占位符 [${got}] 与 zh_CN [${want}] 不一致`);
      phFail++; fail++;
    }
  }
}
if (!phFail) console.log(`✓ 占位符 $N 一致性：${refKeys.length} keys × ${dirs.length} 语言全部一致`);

// 引用完整性：HTML data-i18n / data-i18n-ph 与 JS i18n('key') 必须存在于 zh_CN
const used = new Set();
for (const f of ['popup.html', 'options.html', 'onboarding.html']) {
  const html = fs.readFileSync(path.join(EXT, f), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)) used.add(m[1]);
}
for (const f of ['popup.js', 'options.js', 'background.js', 'onboarding.js']) {
  const js = fs.readFileSync(path.join(EXT, f), 'utf8');
  for (const m of js.matchAll(/\bi18n\(\s*'([^']+)'/g)) used.add(m[1]);
}
const unresolved = [...used].filter(k => !refKeys.includes(k));
if (unresolved.length) { console.error(`✗ 代码引用但 zh_CN 缺失: ${unresolved}`); fail++; }
else console.log(`✓ 代码/HTML 引用的 ${used.size} 个 key 全部存在`);

// manifest.json 合法性与 __MSG_ 引用
try {
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const refs = JSON.stringify(mf).match(/__MSG_([A-Za-z0-9_]+)__/g) || [];
  const bad = refs.map(r => r.slice(6, -2)).filter(k => !refKeys.includes(k));
  if (bad.length) { console.error(`✗ manifest 引用缺失 key: ${bad}`); fail++; }
  else console.log(`✓ manifest.json 合法，default_locale=${mf.default_locale}，__MSG_ 引用 ${refs.length} 处全部存在`);
} catch (e) { console.error(`✗ manifest.json 解析失败: ${e.message}`); fail++; }

console.log(fail ? `\n结果: ${fail} 项失败` : '\n结果: 全部通过');
process.exit(fail ? 1 : 0);
