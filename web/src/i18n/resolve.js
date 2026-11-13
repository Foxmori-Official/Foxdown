export const SUPPORTED_LOCALES = ['en', 'zh-CN']

export function resolveLocale(preference, detected) {
  if (preference && preference !== 'auto') {
    return SUPPORTED_LOCALES.includes(preference) ? preference : 'en'
  }
  const language = detected || (typeof navigator !== 'undefined' && navigator.language) || 'en'
  return /^zh(?:[-_]|$)/i.test(String(language)) ? 'zh-CN' : 'en'
}
