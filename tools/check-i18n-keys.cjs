// 校验 web/src/i18n/locales 下所有语言文件的 key 集合一致（0 缺失 0 多余）。
// 用法：node tools/check-i18n-keys.cjs
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'web', 'src', 'i18n', 'locales');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js')).sort();

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

const sets = new Map();
for (const f of files) {
  const mod = require(path.join(DIR, f));
  sets.set(f, flatten(mod.default || mod, '', new Set()));
}

const base = sets.get('zh-CN.js');
let fail = 0;
for (const [f, s] of sets) {
  const missing = [...base].filter(k => !s.has(k));
  const extra = [...s].filter(k => !base.has(k));
  if (missing.length || extra.length) {
    fail = 1;
    console.error(`[FAIL] ${f}: missing ${missing.length}, extra ${extra.length}`);
    for (const k of missing) console.error(`  - missing: ${k}`);
    for (const k of extra) console.error(`  + extra:   ${k}`);
  } else {
    console.log(`[OK] ${f}: ${s.size} keys`);
  }
}
console.log(fail ? 'i18n key parity: FAILED' : `i18n key parity: OK (${files.length} files, ${base.size} keys each)`);
process.exit(fail);
