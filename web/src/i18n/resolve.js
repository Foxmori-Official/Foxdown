// 语言解析（纯函数、零依赖，供 index.js 与单测共用）。
// 兜底规则：英语。显式偏好不在支持列表 → 'en'；auto 时浏览器语言
// 精确/地区/前缀匹配全部失败 → 'en'（与扩展端 manifest default_locale: en 对齐）。
export const SUPPORTED_LOCALES = ['en', 'de', 'es', 'fr', 'pt-BR', 'ja', 'zh-CN', 'zh-TW', 'ko']

export function resolveLocale(preference, detected) {
  if (preference && preference !== 'auto') {
    return SUPPORTED_LOCALES.includes(preference) ? preference : 'en'
  }
  // detected 仅供测试注入；运行时取浏览器首选语言，缺失时落到英语
  const nav = String(detected || (typeof navigator !== 'undefined' && navigator.language) || 'en')
  const lower = nav.toLowerCase()
  const exact = SUPPORTED_LOCALES.find((s) => s.toLowerCase() === lower)
  if (exact) return exact
  const prefix = lower.split('-')[0]
  if (prefix === 'zh') {
    return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh-CN'
  }
  if (prefix === 'pt') return 'pt-BR'
  const byPrefix = SUPPORTED_LOCALES.find((s) => s.toLowerCase().split('-')[0] === prefix)
  return byPrefix || 'en'
}
