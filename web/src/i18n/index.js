import { createI18n } from 'vue-i18n'
import en from './locales/en.js'
import de from './locales/de.js'
import es from './locales/es.js'
import fr from './locales/fr.js'
import ptBR from './locales/pt-BR.js'
import ja from './locales/ja.js'
import zhCN from './locales/zh-CN.js'
import zhTW from './locales/zh-TW.js'
import ko from './locales/ko.js'
import { SUPPORTED_LOCALES, resolveLocale } from './resolve.js'

export { SUPPORTED_LOCALES, resolveLocale }

const i18n = createI18n({
  legacy: false,
  locale: resolveLocale('auto'),
  fallbackLocale: 'en',
  messages: {
    en,
    de,
    es,
    fr,
    'pt-BR': ptBR,
    ja,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ko
  }
})

export default i18n
