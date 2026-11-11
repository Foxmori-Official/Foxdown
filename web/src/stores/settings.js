import { defineStore } from 'pinia'
import { api, setAuthToken } from '../api/client'
import i18n, { resolveLocale } from '../i18n'

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: {},
    loaded: false,
    systemDark: mediaQuery.matches
  }),
  getters: {
    theme(state) {
      return state.settings.theme || 'auto'
    },
    isDark() {
      if (this.theme === 'dark') return true
      if (this.theme === 'light') return false
      return this.systemDark
    },
    locale(state) {
      return state.settings.locale || 'auto'
    }
  },
  actions: {
    async fetchSettings() {
      const data = await api.getSettings()
      this.settings = data || {}
      this.loaded = true
      setAuthToken(this.settings.apiToken || '')
      this.applyTheme()
      this.applyLocale()
    },
    async saveSettings(patch) {
      const resp = await api.saveSettings(patch)
      Object.assign(this.settings, patch)
      setAuthToken(this.settings.apiToken || '')
      this.applyTheme()
      this.applyLocale()
      return resp
    },
    applyTheme() {
      document.documentElement.classList.toggle('dark', this.isDark)
    },
    applyLocale() {
      i18n.global.locale.value = resolveLocale(this.locale)
      document.documentElement.lang = i18n.global.locale.value
    },
    initThemeListener() {
      mediaQuery.addEventListener('change', (e) => {
        this.systemDark = e.matches
        this.applyTheme()
      })
      this.applyTheme()
    },
    initLocaleListener() {
      window.addEventListener('languagechange', () => {
        // auto 模式下跟随系统语言变化
        if (this.locale === 'auto') this.applyLocale()
      })
      this.applyLocale()
    }
  }
})
