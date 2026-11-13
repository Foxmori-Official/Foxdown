import { createI18n } from 'vue-i18n'
import en from './locales/en.js'
import zhCN from './locales/zh-CN.js'
import { SUPPORTED_LOCALES, resolveLocale } from './resolve.js'

export { SUPPORTED_LOCALES, resolveLocale }

export default createI18n({
  legacy: false,
  locale: resolveLocale('auto'),
  fallbackLocale: 'en',
  messages: { en, 'zh-CN': zhCN }
})
