<template>
  <el-config-provider :locale="epLocale">
  <div class="app-layout">
    <aside class="side-nav">
      <div class="nav-logo">
        <img class="nav-logo-img" src="/logo.png" alt="" />
        <div class="nav-identity">
          <strong>Foxdown</strong>
          <span>Foxmori · v{{ appVersion }}</span>
        </div>
      </div>
      <nav class="nav-items">
        <template v-for="item in navItems" :key="item.key">
        <button type="button"
          :id="item.key === 'settings' ? 'settings-toggle' : undefined"
          class="nav-item"
          :class="{ active: view === item.key }"
          :title="item.label"
          :aria-current="view === item.key && (item.key !== 'settings' || !settingsExpanded) ? 'page' : undefined"
          :aria-expanded="item.key === 'settings' ? view === 'settings' && settingsExpanded : undefined"
          :aria-controls="item.key === 'settings' ? 'settings-navigation' : undefined"
          @click="selectView(item.key)"
          @keydown="item.key === 'settings' && onSettingsToggleKeydown($event)"
        >
          <el-icon :size="18"><component :is="item.icon" /></el-icon>
          <span class="nav-label">{{ item.label }}</span>
          <svg v-if="item.key === 'settings'" class="nav-chevron" :class="{ expanded: view === 'settings' && settingsExpanded }"
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
        <div v-if="item.key === 'settings'" v-show="view === 'settings' && settingsExpanded"
          id="settings-navigation" class="settings-subnav" role="tablist" aria-orientation="vertical"
          :aria-label="t('common.navSettings')" @keydown="onSettingsGroupKeydown">
          <button v-for="group in settingsGroups" :key="group.id" type="button" role="tab"
            :id="'tab-' + group.id" class="settings-subitem" :aria-controls="group.id"
            :aria-selected="activeSettingsGroup === group.id" :tabindex="activeSettingsGroup === group.id ? 0 : -1"
            @click="selectSettingsGroup(group.id)">{{ t(group.label) }}</button>
        </div>
        </template>
      </nav>
      <div class="nav-footer">
        <a class="nav-brand" href="https://foxmori.com" target="_blank" rel="noopener">Foxmori <span aria-hidden="true">↗</span></a>
        <el-tooltip :content="isDark ? t('common.toLight') : t('common.toDark')" placement="top">
          <button type="button" class="nav-item theme-toggle" :aria-label="isDark ? t('common.toLight') : t('common.toDark')" @click="toggleTheme">
            <el-icon :size="18">
              <Sunny v-if="isDark" />
              <Moon v-else />
            </el-icon>
          </button>
        </el-tooltip>
      </div>
    </aside>

    <!-- 主内容区 -->
    <main class="main-area">
      <header class="main-header">
        <h1 class="app-title">{{ viewTitle }}</h1>
        <span class="conn-status" :class="connectionState" role="status">
          <span class="conn-dot"></span>
          {{ connText }}
        </span>
      </header>
      <section ref="mainBody" class="main-body">
        <form v-if="!settingsStore.loaded || connectionFailure" class="connection-card" @submit.prevent="connectBackend">
          <h2>{{ t('common.connectionTitle') }}</h2>
          <template v-if="connectionFailure">
            <p id="connectionError" role="alert">{{ connectionError }}</p>
            <template v-if="connectionFailure === 'unauthorized'">
              <label for="connectionToken">{{ t('common.connectionToken') }}</label>
              <input id="connectionToken" ref="connectionTokenInput" v-model="connectionToken" type="password"
                required autocomplete="off" aria-describedby="connectionError" :disabled="connecting" />
            </template>
            <button type="submit" :disabled="connecting || (connectionFailure === 'unauthorized' && !connectionToken.trim())">
              {{ connecting ? t('common.connecting') : t('common.connectionRetry') }}
            </button>
          </template>
          <p v-else>{{ t('common.connecting') }}</p>
        </form>
        <div v-else-if="tasksStore.reconnecting" class="connection-notice">
          <p>{{ t('common.connectionUpdatesPaused') }}</p>
          <button type="button" :disabled="connecting" @click="connectBackend">{{ t('common.connectionRetry') }}</button>
        </div>
        <Tasks v-if="settingsStore.loaded" v-show="!connectionFailure && view === 'tasks'" />
        <Settings v-if="settingsStore.loaded && settingsVisited" v-show="!connectionFailure && view === 'settings'"
          :active-group="activeSettingsGroup" />
      </section>
    </main>
  </div>
  </el-config-provider>
</template>

<script setup>
import { ElConfigProvider, ElIcon, ElTooltip } from 'element-plus'
import 'element-plus/es/components/config-provider/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/tooltip/style/css'

import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from './stores/settings'
import { useTasksStore } from './stores/tasks'
import Tasks from './views/Tasks.vue'
const Settings = defineAsyncComponent(() => import('./views/Settings.vue'))
import { getAuthToken, setAuthToken } from './api/client'
import { EP_LOCALES } from './i18n/element'
import { version as appVersion } from '../package.json'

const { t, locale } = useI18n()

const navItems = computed(() => [
  { key: 'tasks', label: t('common.navTasks'), icon: 'Download' },
  { key: 'settings', label: t('common.navSettings'), icon: 'Setting' }
])

const view = ref('tasks')
const settingsVisited = ref(false)
const settingsExpanded = ref(false)
const activeSettingsGroup = ref('sec-basic')
const mainBody = ref(null)
const settingsGroups = [
  { id: 'sec-basic', label: 'settings.groupBasic' },
  { id: 'sec-rpc', label: 'settings.groupRpc' },
  { id: 'sec-stream', label: 'settings.groupStream' },
  { id: 'sec-bt', label: 'settings.groupBt' },
  { id: 'sec-post', label: 'settings.groupPost' },
  { id: 'sec-proxy', label: 'settings.groupProxy' },
  { id: 'sec-app', label: 'settings.groupApp' }
]
function resetWorkspaceScroll() { mainBody.value?.scrollTo({ top: 0 }) }
watch(view, value => {
  if (value === 'settings') settingsVisited.value = true
  nextTick(resetWorkspaceScroll)
})

function selectView(key) {
  if (key === 'settings') settingsExpanded.value = view.value !== 'settings' || !settingsExpanded.value
  view.value = key
}

function selectSettingsGroup(id) {
  activeSettingsGroup.value = id
  settingsExpanded.value = true
  view.value = 'settings'
  nextTick(resetWorkspaceScroll)
}

function onSettingsToggleKeydown(event) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    settingsExpanded.value = false
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault()
    settingsExpanded.value = true
    view.value = 'settings'
    nextTick(() => document.getElementById('tab-' + activeSettingsGroup.value)?.focus())
  }
}

function onSettingsGroupKeydown(event) {
  const current = settingsGroups.findIndex(group => group.id === activeSettingsGroup.value)
  let index
  if (event.key === 'ArrowDown') index = (current + 1) % settingsGroups.length
  else if (event.key === 'ArrowUp') index = (current + settingsGroups.length - 1) % settingsGroups.length
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = settingsGroups.length - 1
  else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    settingsExpanded.value = false
    document.getElementById('settings-toggle')?.focus()
    return
  } else return
  event.preventDefault()
  const id = settingsGroups[index].id
  selectSettingsGroup(id)
  document.getElementById('tab-' + id)?.focus()
}
const connectionToken = ref(getAuthToken())
const connectionTokenInput = ref(null)
const connectionFailure = ref('')
const connecting = ref(false)
const settingsStore = useSettingsStore()
const tasksStore = useTasksStore()

const viewTitle = computed(() => (view.value === 'tasks' ? t('common.navTasks') : t('common.navSettings')))
const isDark = computed(() => settingsStore.isDark)

const connectionState = computed(() => {
  if (connecting.value) return 'connecting'
  if (connectionFailure.value) return connectionFailure.value
  if (tasksStore.connected) return 'online'
  return tasksStore.reconnecting ? 'reconnecting' : 'connecting'
})
const connectionLabels = {
  connecting: 'common.connecting',
  unauthorized: 'common.connectionAuthStatus',
  offline: 'common.connectionOfflineStatus',
  online: 'common.connected',
  reconnecting: 'common.connectionReconnectStatus'
}
const connText = computed(() => t(connectionLabels[connectionState.value]))
const connectionError = computed(() => connectionFailure.value === 'unauthorized'
  ? t('common.connectionUnauthorized')
  : t('common.connectionOffline', { address: window.location.origin }))

const epLocale = computed(() => EP_LOCALES[locale.value] || EP_LOCALES.en)

function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark'
  settingsStore.saveSettings({ theme: next }).catch(() => {})
}

async function connectBackend() {
  if (connecting.value) return
  connecting.value = true
  if (connectionFailure.value === 'unauthorized') setAuthToken(connectionToken.value.trim())
  try {
    await settingsStore.fetchSettings()
    connectionFailure.value = ''
    tasksStore.connect(getAuthToken())
  } catch (error) {
    connectionFailure.value = error.status === 401 ? 'unauthorized' : 'offline'
    if (connectionFailure.value === 'unauthorized') connectionToken.value = getAuthToken()
  } finally {
    connecting.value = false
  }
  if (connectionFailure.value === 'unauthorized') {
    await nextTick()
    connectionTokenInput.value?.focus()
  }
}

onMounted(async () => {
  settingsStore.initThemeListener()
  settingsStore.initLocaleListener()
  await connectBackend()
})

// apiToken 变化时重建 WS 连接
watch(
  () => settingsStore.settings.apiToken,
  (token) => {
    if (!connecting.value) tasksStore.reconnectWithToken(token || '')
  }
)
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100%;
}

.side-nav {
  width: 232px;
  min-height: 0;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
  background: var(--kd-nav-bg);
  border-right: 1px solid var(--kd-border);
  padding: 24px 14px 16px;
}

.nav-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 16px;
  border-bottom: 1px solid var(--kd-border);
}

.nav-logo-img {
  width: 38px;
  height: 38px;
  border-radius: var(--kd-radius-icon);
}

.nav-identity strong {
  display: block;
  font-size: 23px;
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.035em;
}

.nav-identity span {
  display: block;
  margin-top: 4px;
  font: 10px var(--kd-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--kd-text-tertiary);
}

.nav-items {
  display: grid;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
}

.nav-item {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: start;
  padding: 10px 12px;
  border-radius: var(--kd-radius-ctrl);
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  color: var(--kd-text-secondary);
  transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
  background: var(--kd-hover-bg);
  color: var(--kd-text-primary);
}

.nav-item.active {
  color: var(--kd-primary);
  background: var(--kd-primary-soft);
  font-weight: 650;
}

.nav-label { flex: 1; }
.nav-chevron { flex-shrink: 0; transition: transform 150ms ease; }
.nav-chevron.expanded { transform: rotate(90deg); }
.settings-subnav {
  display: grid;
  gap: 4px;
  margin: 0 0 8px 20px;
  padding-left: 10px;
  border-left: 1px solid var(--kd-border);
}
.settings-subitem {
  min-width: 0;
  border: 0;
  border-radius: var(--kd-radius-ctrl);
  padding: 9px 10px;
  background: transparent;
  color: var(--kd-text-secondary);
  font: inherit;
  font-size: var(--kd-meta);
  line-height: 1.4;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.settings-subitem:hover { background: var(--kd-hover-bg); color: var(--kd-text-primary); }
.settings-subitem[aria-selected="true"] { background: var(--kd-primary); color: var(--kd-on-primary); font-weight: 600; }

.nav-footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--kd-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-brand {
  font-size: 12px;
  color: var(--kd-text-tertiary);
  padding: 8px;
}

.theme-toggle { width: auto; padding: 9px; }

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  --workspace-padding: clamp(20px, 4vw, 48px);
}

.main-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  width: min(100%, 1200px);
  margin-inline: auto;
  padding: 30px var(--workspace-padding) 18px;
}

.app-title {
  margin: 0;
  font-size: var(--kd-t1);
  font-weight: 750;
  line-height: 1.2;
  letter-spacing: -0.035em;
}

.conn-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 20px;
  background: var(--kd-warning-soft);
  color: var(--kd-warning);
}

.conn-status.online {
  background: var(--kd-success-soft);
  color: var(--kd-success);
}

.conn-status.offline, .conn-status.unauthorized {
  background: var(--kd-danger-soft);
  color: var(--kd-danger);
}

.conn-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: currentColor;
}

.main-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: min(100%, 1200px);
  margin-inline: auto;
  padding: 0 var(--workspace-padding) 28px;
}

.connection-card {
  max-width: 480px;
  margin: 24px auto;
  padding: var(--kd-space-6);
  border: 1px solid var(--kd-border);
  border-radius: var(--kd-radius-card);
  background: var(--kd-card-bg);
  display: grid;
  gap: 12px;
}

.connection-card h2 { margin: 0; font-size: var(--kd-t2); }
.connection-card p { margin: 0; color: var(--kd-text-secondary); line-height: 1.55; overflow-wrap: anywhere; }
.connection-card [role="alert"] { color: var(--kd-danger); }

.connection-card input, .connection-card button, .connection-notice button {
  min-width: 0;
  font: inherit;
  padding: 10px 12px;
  border: 1px solid var(--kd-border-input);
  border-radius: var(--kd-radius-ctrl);
}

.connection-card input { color: var(--kd-text-primary); background: var(--kd-bg); }
.connection-card button { background: var(--kd-primary); color: var(--kd-on-primary); cursor: pointer; }
.connection-card button:hover { background: var(--kd-primary-hover); }
.connection-card button:disabled, .connection-notice button:disabled { opacity: 0.65; cursor: not-allowed; }

.connection-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: var(--kd-radius-ctrl);
  background: var(--kd-warning-soft);
  color: var(--kd-warning);
}
.connection-notice p { margin: 0; }
.connection-notice button { color: inherit; background: var(--kd-card-bg); cursor: pointer; }

</style>
