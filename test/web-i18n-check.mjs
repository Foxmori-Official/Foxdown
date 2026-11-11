// Web 端 i18n 校验：web/src/i18n/locales 下 9 个语言文件的 key 集合（拍平为 a.b.c）
// 与 zh-CN 完全一致（0 缺失 0 多余），且值均为非空字符串；
// 另测 resolveLocale 的英语兜底（偏好/浏览器语言不在支持列表 → en）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'i18n', 'locales')
const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.js')).sort()

function flatten(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') out.push(...flatten(v, key))
    else out.push(key)
  }
  return out.sort()
}

const msgs = {}
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(LOCALES_DIR, f)).href)
  msgs[f.replace(/\.js$/, '')] = mod.default
}

const refName = 'zh-CN'
const refKeys = flatten(msgs[refName])
let fail = 0

console.log(`参照 ${refName}: ${refKeys.length} 个 key；发现语言: ${files.join(', ')}`)
if (files.length !== 9) {
  console.error(`✗ 语言文件数 = ${files.length}，应为 9`)
  fail++
}

for (const [name, obj] of Object.entries(msgs)) {
  const keys = flatten(obj)
  const missing = refKeys.filter((k) => !keys.includes(k))
  const extra = keys.filter((k) => !refKeys.includes(k))
  // 空值检查
  const empty = []
  const walk = (o, p = '') => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k
      if (v && typeof v === 'object') walk(v, key)
      else if (typeof v !== 'string' || !v.trim()) empty.push(key)
    }
  }
  walk(obj)
  if (missing.length || extra.length || empty.length) {
    fail++
    console.error(`✗ ${name}: 缺失 ${missing.length} [${missing}] 多余 ${extra.length} [${extra}] 空值 ${empty.length} [${empty}]`)
  } else {
    console.log(`✓ ${name}: ${keys.length} keys，0 缺失 0 多余`)
  }
}

console.log('== resolveLocale 英语兜底 ==')
const { resolveLocale, SUPPORTED_LOCALES } = await import(
  pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'i18n', 'resolve.js')).href
)
const cases = [
  // [preference, detected, expected, 说明]
  ['ru', undefined, 'en', '显式偏好不支持（ru）→ en'],
  ['xx-UNKNOWN', undefined, 'en', '显式偏好未知值 → en'],
  ['de', undefined, 'de', '显式偏好支持 → 原值'],
  ['auto', 'ru', 'en', 'auto + 浏览器语言不支持（ru）→ en'],
  ['auto', 'xx-UNKNOWN', 'en', 'auto + 浏览器语言未知 → en'],
  ['auto', 'zh-HK', 'zh-TW', 'auto + zh-HK → zh-TW（地区映射）'],
  ['auto', 'zh-MO', 'zh-TW', 'auto + zh-MO → zh-TW（地区映射）'],
  ['auto', 'zh-Hant', 'zh-TW', 'auto + zh-Hant → zh-TW（文字变体映射）'],
  ['auto', 'zh-CN', 'zh-CN', 'auto + zh-CN → zh-CN（精确）'],
  ['auto', 'pt-PT', 'pt-BR', 'auto + pt-PT → pt-BR（葡语映射）'],
  ['auto', 'de-AT', 'de', 'auto + de-AT → de（前缀）'],
  ['auto', 'fr-CA', 'fr', 'auto + fr-CA → fr（前缀）'],
  ['auto', 'ja-JP', 'ja', 'auto + ja-JP → ja（前缀）'],
  ['auto', 'ko-KR', 'ko', 'auto + ko-KR → ko（前缀）'],
  ['auto', 'en-US', 'en', 'auto + en-US → en（前缀）'],
  ['auto', 'es-419', 'es', 'auto + es-419 → es（前缀）'],
]
for (const [pref, detected, expected, name] of cases) {
  const got = resolveLocale(pref, detected)
  if (got === expected) { console.log('  ✓', name) }
  else { console.error(`  ✗ ${name}: 期望 ${expected}，实际 ${got}`); fail++ }
}
// detected 未注入时走真实 navigator.language（因机器而异）——断言环境无关的不变量：
// 无论浏览器语言是什么，解析结果必属支持列表（最终兜底 en）
for (const pref of ['auto', '', undefined]) {
  const got = resolveLocale(pref)
  if (SUPPORTED_LOCALES.includes(got)) {
    console.log(`  ✓ 偏好 ${JSON.stringify(pref)} + 真实 navigator.language → 结果 "${got}" 必属支持列表`)
  } else {
    console.error(`  ✗ 偏好 ${JSON.stringify(pref)} + 真实 navigator.language → 不支持值 "${got}"`)
    fail++
  }
}
if (SUPPORTED_LOCALES.length !== 9) { console.error(`✗ 支持语言数 = ${SUPPORTED_LOCALES.length}，应为 9`); fail++ }

console.log(fail ? `\n结果: ${fail} 项失败` : '\n结果: 全部通过')
process.exit(fail ? 1 : 0)
