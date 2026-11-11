<template>
  <div ref="settingsRoot" class="settings-view" v-loading="!store.loaded">
    <template v-if="store.loaded">
  
      <header class="settings-tools">
        <nav class="settings-index" role="tablist" :aria-label="t('common.navSettings')" @keydown="onGroupKeydown">
          <button v-for="group in settingsGroups" :key="group.id" type="button"
            role="tab" :id="'tab-' + group.id" :aria-controls="group.id"
            :aria-selected="activeGroup === group.id" :tabindex="activeGroup === group.id ? 0 : -1"
            @click="selectGroup(group.id)">{{ t(group.label) }}</button>
        </nav>
        <div class="save-state" role="status" :class="{ 'save-error': saveError }">
          <span>{{ saveError || t(saving ? 'settings.saving' : justSaved ? 'settings.autoSaved' : 'settings.autoSaveHint') }}</span>
          <el-button v-if="saveError" text size="small" @click="persistAll">{{ t('taskrow.retry') }}</el-button>
        </div>
      </header>
      <el-form label-width="160px" label-position="right" class="settings-form">
<!-- 基本 -->
        <section v-show="activeGroup === 'sec-basic'" class="group-card" id="sec-basic" role="tabpanel" aria-labelledby="tab-sec-basic">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupBasic') }}</h2>
            <span class="header-spacer"></span>
            <el-button text class="factory-btn" :disabled="saving" :loading="resetting" @click="factoryReset">
              {{ t('settings.factoryReset') }}
            </el-button>
          </div>

          <!-- 应用组并入：主题与语言 -->
          <el-form-item :label="t('settings.theme')">
          <el-radio-group v-model="form.theme">
          <el-radio-button value="auto">{{ t('settings.themeAuto') }}</el-radio-button>
          <el-radio-button value="light">{{ t('settings.themeLight') }}</el-radio-button>
          <el-radio-button value="dark">{{ t('settings.themeDark') }}</el-radio-button>
          </el-radio-group>
          </el-form-item>
          <el-form-item :label="t('settings.language')">
          <el-select v-model="form.locale" style="width: 320px" @change="onLocaleChange">
          <el-option
          v-for="opt in localeOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
          />
          </el-select>
          </el-form-item>

          <el-form-item :label="t('settings.downloadDir')">
            <el-input v-model="form.downloadDir" :placeholder="t('settings.downloadDirPlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('settings.maxConcurrent')">
            <el-input-number v-model="form.maxConcurrentDownloads" :min="1" :max="20" class="num-stepper" />
          </el-form-item>
          <el-form-item :label="t('settings.dlLimit')">
            <div class="speed-field">
              <el-input-number
                v-model="form.dlLimit"
                :aria-label="t('settings.dlLimit')"
                :min="0"
                :step="1"
                :precision="dlUnit === 'MB' ? 2 : 0"
                class="num-stepper"
              />
              <el-radio-group :model-value="dlUnit" size="small" @update:model-value="(v) => onUnitChange('dl', v)">
                <el-radio-button value="MB">MB/s</el-radio-button>
                <el-radio-button value="KB">KB/s</el-radio-button>
              </el-radio-group>
              <span class="hint">{{ t('settings.speedHint') }}</span>
            </div>
          </el-form-item>
          <el-form-item :label="t('settings.ulLimit')">
            <div class="speed-field">
              <el-input-number
                v-model="form.ulLimit"
                :aria-label="t('settings.ulLimit')"
                :min="0"
                :step="1"
                :precision="ulUnit === 'MB' ? 2 : 0"
                class="num-stepper"
              />
              <el-radio-group :model-value="ulUnit" size="small" @update:model-value="(v) => onUnitChange('ul', v)">
                <el-radio-button value="MB">MB/s</el-radio-button>
                <el-radio-button value="KB">KB/s</el-radio-button>
              </el-radio-group>
              <span class="hint">{{ t('settings.speedHint') }}</span>
            </div>
          </el-form-item>
          <el-form-item :label="t('settings.speedProfilesLabel')">
            <div class="profile-bar">
              <el-button
                v-for="(label, idx) in profileLabels"
                :key="idx"
                size="small"
                :type="activeSpeedProfile === idx ? 'primary' : 'default'"
                :loading="profileApplying === idx"
                @click="applyProfile(idx)"
              >
                {{ label }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item :label="t('settings.resume')">
            <el-switch v-model="form.continueDownloads" />
          </el-form-item>
          <details class="advanced-settings">
          <summary>{{ t('dialog.advanced') }}</summary>
          <el-form-item :label="t('settings.maxConnPerServer')">
            <el-input-number v-model="form.maxConnectionPerServer" :min="1" :max="64" class="num-stepper" />
            <span class="hint">{{ t('settings.maxConnPerServerHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.split')">
            <el-input-number v-model="form.split" :min="1" :max="64" class="num-stepper" />
            <span class="hint">{{ t('settings.splitHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.minSplitSize')">
            <el-input-number v-model="form.minSplitSizeMB" :min="0" :step="1" class="num-stepper" />
            <span class="unit-suffix">MB</span>
            <span class="hint">{{ t('settings.minSplitSizeHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.fileAllocation')">
            <el-select v-model="form.fileAllocation" style="width: 320px">
              <el-option
                v-for="opt in fileAllocOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('settings.diskCache')">
            <el-input-number v-model="form.diskCacheMB" :min="0" :step="1" class="num-stepper" />
            <span class="unit-suffix">MB</span>
            <span class="hint">{{ t('settings.diskCacheHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.userAgent')">
            <el-input v-model="form.userAgent" />
          </el-form-item>
          <el-form-item :label="t('settings.checkCertificate')">
            <el-switch v-model="form.checkCertificate" />
          </el-form-item>

        </details>
        </section>

<!-- RPC / 远程访问 -->
        <section v-show="activeGroup === 'sec-rpc'" class="group-card" id="sec-rpc" role="tabpanel" aria-labelledby="tab-sec-rpc">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupRpc') }}</h2>
          </div>
          <el-form-item :label="t('settings.rpcPort')">
            <el-input
              v-model.number="form.rpcPort"
              type="number"
              class="port-input"
              @blur="form.rpcPort = clampPort(form.rpcPort, 16800)"
            />
          </el-form-item>
          <el-form-item :label="t('settings.rpcListenAll')">
            <el-switch v-model="form.rpcListenAll" @change="onRpcListenAllChange" />
          </el-form-item>
          <el-form-item :label="t('settings.apiToken')">
            <el-input
              v-model="form.apiToken"
              type="password"
              show-password
              :placeholder="t('settings.apiTokenPlaceholder')"
            />
          </el-form-item>
          <el-form-item :label="t('settings.rpcSecret')">
            <div class="secret-bar">
              <el-input v-model="form.rpcSecret" type="password" show-password readonly />
              <el-button size="small" :loading="secretCopying" @click="copySecret">
                {{ t('settings.rpcSecretCopy') }}
              </el-button>
              <el-button size="small" :loading="secretRegenerating" @click="regenerateSecret">
                {{ t('settings.rpcSecretRegen') }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item>
            <span class="hint hint-block">
              {{ t('settings.rpcAccessHint', { port: form.rpcPort || 16800 }) }}
              <el-button text size="small" class="ws-copy" @click="copyWsUrl">{{ t('settings.rpcSecretCopy') }}</el-button>
            </span>
          </el-form-item>
        </section>

<!-- 流媒体 -->
        <section v-show="activeGroup === 'sec-stream'" class="group-card" id="sec-stream" role="tabpanel" aria-labelledby="tab-sec-stream">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupStream') }}</h2>
          </div>
          <el-form-item :label="t('settings.streamThreads')">
            <el-input-number v-model="form.streamThreadCount" :min="1" :max="64" class="num-stepper" />
          </el-form-item>
          <el-form-item :label="t('settings.streamRetry')">
            <el-input-number v-model="form.streamRetryCount" :min="0" :max="20" class="num-stepper" />
          </el-form-item>
          <el-form-item :label="t('settings.streamTimeout')">
            <el-input-number v-model="form.streamTimeoutSec" :min="5" :max="300" :step="5" class="num-stepper" />
          </el-form-item>
          <el-form-item :label="t('settings.streamMux')">
            <el-switch v-model="form.streamMuxAfterDownload" />
            <span class="hint">{{ t('settings.streamMuxHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.liveRecordLimit')">
            <el-input-number v-model="form.streamLiveRecordLimitMin" :min="0" :max="43200" class="num-stepper" />
            <span class="hint">{{ t('settings.liveRecordHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.savePattern')">
            <el-input ref="savePatternInput" v-model="form.savePattern" placeholder="<SaveName>" />
            <div class="var-tags">
              <el-tag
                v-for="v in patternVars"
                :key="v"
                size="small"
                class="var-tag"
                @click="insertVar(v)"
              >{{ '{' + v + '}' }}</el-tag>
            </div>
            <span class="hint hint-block">{{ t('settings.savePatternHint', { braces: '{ }', angles: '< >' }) }}</span>
          </el-form-item>
        </section>

<!-- BT -->
        <section v-show="activeGroup === 'sec-bt'" class="group-card" id="sec-bt" role="tabpanel" aria-labelledby="tab-sec-bt">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupBt') }}</h2>
          </div>
          <el-form-item :label="t('settings.enableDht')">
            <el-switch v-model="form.enableDht" />
          </el-form-item>
          <el-form-item :label="t('settings.enableLpd')">
            <el-switch v-model="form.btEnableLpd" />
          </el-form-item>
          <el-form-item :label="t('settings.trackerList')">
            <el-input
              v-model="form.btTracker"
              type="textarea"
              :rows="5"
              class="tracker-input"
              :placeholder="t('settings.trackerPlaceholder')"
            />
            <div class="tracker-bar">
              <el-checkbox v-model="form.btTrackerAutoUpdate">{{ t('settings.trackerAutoUpdate') }}</el-checkbox>
              <el-button :loading="trackerUpdating" @click="updateTrackers">
                {{ t('settings.trackerUpdateNow') }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item :label="t('settings.seedRatio')">
            <el-input-number v-model="form.seedRatio" :min="0" :max="10" :step="0.1" class="num-stepper" />
            <span class="hint">{{ t('settings.seedRatioHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.seedTime')">
            <el-input-number v-model="form.seedTime" :min="0" :max="525600" class="num-stepper" />
            <span class="hint">{{ t('settings.seedTimeHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.listenPort')">
            <el-input
              v-model.number="form.listenPort"
              type="number"
              class="port-input"
              @blur="form.listenPort = clampPort(form.listenPort, 51413)"
            />
          </el-form-item>
          <el-form-item :label="t('settings.btMaxPeers')">
            <el-input-number v-model="form.btMaxPeers" :min="1" :max="512" class="num-stepper" />
          </el-form-item>
          <el-form-item :label="t('settings.upnpEnabled')">
            <el-switch v-model="form.upnpEnabled" />
            <span class="hint">{{ t('settings.upnpHint') }}</span>
          </el-form-item>
        </section>

<!-- 后处理 -->
        <section v-show="activeGroup === 'sec-post'" class="group-card" id="sec-post" role="tabpanel" aria-labelledby="tab-sec-post">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupPost') }}</h2>
          </div>
          <el-form-item :label="t('settings.webhookUrl')">
            <div class="webhook-bar">
              <el-input v-model="form.webhookUrl" placeholder="https://…" />
              <el-button :loading="webhookTesting" @click="testWebhook">
                {{ t('settings.webhookTest') }}
              </el-button>
            </div>
            <span class="hint hint-block">{{ t('settings.webhookHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.postScript')">
            <el-input v-model="form.postScript" :placeholder="t('settings.postScriptPlaceholder')" />
            <span class="hint hint-block">{{ t('settings.postScriptHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('settings.autoExtract')">
            <el-switch v-model="form.autoExtract" />
            <span class="hint">{{ t('settings.autoExtractHint') }}</span>
          </el-form-item>
        </section>

<!-- 代理 -->
        <section v-show="activeGroup === 'sec-proxy'" class="group-card" id="sec-proxy" role="tabpanel" aria-labelledby="tab-sec-proxy">
          <div class="group-header">
            <h2 class="group-title">{{ t('settings.groupProxy') }}</h2>
          </div>
          <el-form-item :label="t('settings.proxyEnabled')">
            <el-switch v-model="form.proxyEnabled" />
          </el-form-item>
          <div class="proxy-fields" :class="{ 'proxy-off': !form.proxyEnabled }">
            <el-form-item :label="t('settings.proxyServer')">
              <el-input v-model="form.proxyServer" :disabled="!form.proxyEnabled" :placeholder="t('settings.proxyServerPlaceholder')" />
            </el-form-item>
            <el-form-item :label="t('settings.proxyUser')">
              <el-input v-model="form.proxyUser" :disabled="!form.proxyEnabled" />
            </el-form-item>
            <el-form-item :label="t('settings.proxyPasswd')">
              <el-input v-model="form.proxyPasswd" type="password" show-password :disabled="!form.proxyEnabled" />
            </el-form-item>
            <el-form-item :label="t('settings.noProxy')">
              <el-input v-model="form.noProxy" :disabled="!form.proxyEnabled" />
              <span class="hint">{{ t('settings.noProxyHint') }}</span>
            </el-form-item>
          </div>
        </section>
        <section v-show="activeGroup === 'sec-app'" class="group-card" id="sec-app" role="tabpanel" aria-labelledby="tab-sec-app">
          <div class="group-header"><h2 class="group-title">{{ t('settings.groupApp') }}</h2></div>
          <el-form-item v-if="desktop && loginAtStartup !== null" :label="t('settings.desktopStartup')">
            <el-switch v-model="loginAtStartup" @change="setStartup" :loading="savingStartup" />
          </el-form-item>
          <div class="app-links">
            <a href="https://github.com/Foxmori-Official/Foxdown#browser-extension" target="_blank" rel="noopener">{{ t('settings.extensionGuide') }}</a>
            <a href="https://github.com/Foxmori-Official/Foxdown/releases" target="_blank" rel="noopener">{{ t('settings.checkUpdates') }}</a>
          </div>
        </section>
      </el-form>




      
    </template>
  </div>
</template>

<script setup>
import { ElButton, ElCheckbox, ElForm, ElFormItem, ElIcon, ElInput, ElInputNumber, ElOption, ElRadioButton, ElRadioGroup, ElSelect, ElSwitch, ElTag } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/checkbox/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/form-item/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/radio-button/style/css'
import 'element-plus/es/components/radio-group/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/tag/style/css'

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSettingsStore } from '../stores/settings'
import { api } from '../api/client'
import i18n, { resolveLocale } from '../i18n'
import {
  bytesToSpeedDisplay,
  speedDisplayToBytes,
  msToSeconds,
  secondsToMs,
  sizeStrToMB,
  mbToSizeStr,
  trackersToText,
  textToTrackers,
  isValidPort,
  clampPort
} from '../utils/units'

/** 语言选择即时生效（保存时才持久化到服务器） */
function onLocaleChange(val) {
  i18n.global.locale.value = resolveLocale(val || 'auto')
}

const { t } = useI18n()
const store = useSettingsStore()
const saving = ref(false)
const saveError = ref('')
const desktop = window.foxdownDesktop
const loginAtStartup = ref(null)
const savingStartup = ref(false)
const settingsRoot = ref(null)
const activeGroup = ref('sec-basic')
const settingsGroups = [
  { id: 'sec-basic', label: 'settings.groupBasic' },
  { id: 'sec-rpc', label: 'settings.groupRpc' },
  { id: 'sec-stream', label: 'settings.groupStream' },
  { id: 'sec-bt', label: 'settings.groupBt' },
  { id: 'sec-post', label: 'settings.groupPost' },
  { id: 'sec-proxy', label: 'settings.groupProxy' },
  { id: 'sec-app', label: 'settings.groupApp' }
]

function selectGroup(id) {
  activeGroup.value = id
  nextTick(() => { settingsRoot.value?.closest('.main-body')?.scrollTo({ top: 0 }) })
}

function onGroupKeydown(event) {
  const current = settingsGroups.findIndex(group => group.id === activeGroup.value)
  let index
  if (event.key === 'ArrowRight') index = (current + 1) % settingsGroups.length
  else if (event.key === 'ArrowLeft') index = (current + settingsGroups.length - 1) % settingsGroups.length
  else if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = settingsGroups.length - 1
  else return
  event.preventDefault()
  const id = settingsGroups[index].id
  selectGroup(id)
  document.getElementById('tab-' + id)?.focus()
}

async function setStartup(value) {
  savingStartup.value = true
  try {
    loginAtStartup.value = (await desktop.setLoginItem(value)).openAtLogin
  } catch (error) {
    loginAtStartup.value = !value
    ElMessage.error(t('settings.saveFailed', { msg: error.message }))
  } finally {
    savingStartup.value = false
  }
}
const resetting = ref(false)
const trackerUpdating = ref(false)
const webhookTesting = ref(false)
const secretCopying = ref(false)
const secretRegenerating = ref(false)
const profileApplying = ref(-1)
const activeSpeedProfile = ref(-1)
const savePatternInput = ref(null)
const dlUnit = ref('MB')
const ulUnit = ref('MB')

const patternVars = ['SaveName', 'Resolution', 'Codecs', 'Bandwidth', 'Id', 'Host', 'Date']

// 出厂默认值：与 server/src/config.js 的 DEFAULT_SETTINGS 同值（后端改动时需同步此处）。
// downloadDir 为机器相关路径（后端 ROOT/downloads），不在前端重置。
const FACTORY_DEFAULTS = {
  maxConcurrentDownloads: 5,
  maxConnectionPerServer: 16,
  split: 16,
  minSplitSize: '1M',
  maxOverallDownloadLimit: 0,
  maxOverallUploadLimit: 0,
  continueDownloads: true,
  fileAllocation: 'none',
  diskCache: '64M',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  checkCertificate: true,
  proxyEnabled: false,
  proxyServer: '',
  proxyUser: '',
  proxyPasswd: '',
  noProxy: '',
  enableDht: true,
  btEnableLpd: true,
  btMaxPeers: 128,
  btTracker: '',
  btTrackerAutoUpdate: true,
  seedRatio: 1.0,
  seedTime: 0,
  listenPort: 51413,
  upnpEnabled: false,
  rpcPort: 16800,
  rpcListenAll: false,
  streamThreadCount: 8,
  streamRetryCount: 5,
  streamTimeoutMs: 20000,
  streamMuxAfterDownload: true,
  streamLiveRecordLimitMin: 0,
  savePattern: '<SaveName>',
  webhookUrl: '',
  postScript: '',
  autoExtract: false,
  apiToken: '',
  theme: 'auto',
  locale: 'zh-CN'
}

const FALLBACK_PROFILES = [
  { down: 0, up: 0 },
  { down: 2097152, up: 1048576 },
  { down: 10485760, up: 5242880 }
]

const speedProfiles = computed(() =>
  (Array.isArray(store.settings.speedProfiles) && store.settings.speedProfiles.length
    ? store.settings.speedProfiles
    : FALLBACK_PROFILES)
)

const profileLabels = computed(() => [
  t('settings.profileFull'),
  t('settings.profileOffice'),
  t('settings.profileNight')
])

const fileAllocOptions = computed(() => [
  { value: 'none', label: t('settings.fileAllocNone') },
  { value: 'falloc', label: t('settings.fileAllocFalloc') },
  { value: 'trunc', label: t('settings.fileAllocTrunc') },
  { value: 'prealloc', label: t('settings.fileAllocPrealloc') }
])

const localeOptions = computed(() => [
  { value: 'auto', label: t('settings.langAuto') },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ja', label: '日本語' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ko', label: '한국어' }
])

// 表单持有 UI 显示值（单位换算后的），存储格式的还原在 save() 里做
const form = reactive({
  downloadDir: '',
  maxConcurrentDownloads: 5,
  maxConnectionPerServer: 16,
  split: 16,
  dlLimit: 0,
  ulLimit: 0,
  continueDownloads: true,
  minSplitSizeMB: 1,
  fileAllocation: 'none',
  diskCacheMB: 64,
  userAgent: '',
  checkCertificate: true,
  proxyEnabled: false,
  proxyServer: '',
  proxyUser: '',
  proxyPasswd: '',
  noProxy: '',
  enableDht: true,
  btEnableLpd: true,
  btTracker: '',
  btTrackerAutoUpdate: true,
  seedRatio: 1,
  seedTime: 0,
  listenPort: 51413,
  btMaxPeers: 128,
  upnpEnabled: false,
  streamThreadCount: 8,
  streamRetryCount: 5,
  streamTimeoutSec: 30,
  streamMuxAfterDownload: true,
  streamLiveRecordLimitMin: 0,
  savePattern: '<SaveName>',
  webhookUrl: '',
  postScript: '',
  autoExtract: false,
  rpcPort: 16800,
  rpcListenAll: false,
  rpcSecret: '',
  apiToken: '',
  theme: 'auto',
  locale: 'auto'
})

// ---- Load 层：存储格式 -> UI 显示值 ----
function fillForm() {
  const s = store.settings
  form.downloadDir = s.downloadDir ?? ''
  form.maxConcurrentDownloads = s.maxConcurrentDownloads ?? 5
  form.maxConnectionPerServer = s.maxConnectionPerServer ?? 16
  form.split = s.split ?? 16
  // <1 MB/s 的限速自动切 KB/s 档，避免 0.29 这类换算残留精度
  const dlBytes = s.maxOverallDownloadLimit ?? 0
  const ulBytes = s.maxOverallUploadLimit ?? 0
  dlUnit.value = dlBytes > 0 && dlBytes < 1048576 ? 'KB' : 'MB'
  ulUnit.value = ulBytes > 0 && ulBytes < 1048576 ? 'KB' : 'MB'
  form.dlLimit = bytesToSpeedDisplay(dlBytes, dlUnit.value)
  form.ulLimit = bytesToSpeedDisplay(ulBytes, ulUnit.value)
  form.continueDownloads = s.continueDownloads ?? true
  form.minSplitSizeMB = sizeStrToMB(s.minSplitSize ?? '1M')
  form.fileAllocation = s.fileAllocation ?? 'none'
  form.diskCacheMB = sizeStrToMB(s.diskCache ?? '64M')
  form.userAgent = s.userAgent ?? ''
  form.checkCertificate = s.checkCertificate ?? true
  form.proxyEnabled = s.proxyEnabled ?? false
  form.proxyServer = s.proxyServer ?? ''
  form.proxyUser = s.proxyUser ?? ''
  form.proxyPasswd = s.proxyPasswd ?? ''
  form.noProxy = s.noProxy ?? ''
  form.enableDht = s.enableDht ?? true
  form.btEnableLpd = s.btEnableLpd ?? true
  form.btTracker = trackersToText(s.btTracker ?? '')
  form.btTrackerAutoUpdate = s.btTrackerAutoUpdate ?? true
  form.seedRatio = s.seedRatio ?? 1
  form.seedTime = s.seedTime ?? 0
  form.listenPort = s.listenPort ?? 51413
  form.btMaxPeers = s.btMaxPeers ?? 128
  form.upnpEnabled = s.upnpEnabled ?? false
  form.streamThreadCount = s.streamThreadCount ?? 8
  form.streamRetryCount = s.streamRetryCount ?? 5
  form.streamTimeoutSec = msToSeconds(s.streamTimeoutMs ?? 20000) || 30
  form.streamMuxAfterDownload = s.streamMuxAfterDownload ?? true
  form.streamLiveRecordLimitMin = s.streamLiveRecordLimitMin ?? 0
  form.savePattern = s.savePattern ?? '<SaveName>'
  form.webhookUrl = s.webhookUrl ?? ''
  form.postScript = s.postScript ?? ''
  form.autoExtract = s.autoExtract ?? false
  form.rpcPort = s.rpcPort ?? 16800
  form.rpcListenAll = s.rpcListenAll ?? false
  form.rpcSecret = s.rpcSecret || '' // 只读展示，不参与保存
  form.apiToken = s.apiToken ?? ''
  form.theme = s.theme ?? 'auto'
  form.locale = s.locale || 'auto'
  activeSpeedProfile.value = s.activeSpeedProfile ?? -1
}

// ---- Save 层：UI 显示值 -> 存储格式 ----
function buildPatch() {
  return {
    downloadDir: form.downloadDir,
    maxConcurrentDownloads: form.maxConcurrentDownloads,
    maxConnectionPerServer: form.maxConnectionPerServer,
    split: form.split,
    maxOverallDownloadLimit: speedDisplayToBytes(form.dlLimit, dlUnit.value),
    maxOverallUploadLimit: speedDisplayToBytes(form.ulLimit, ulUnit.value),
    continueDownloads: form.continueDownloads,
    minSplitSize: mbToSizeStr(form.minSplitSizeMB),
    fileAllocation: form.fileAllocation,
    diskCache: mbToSizeStr(form.diskCacheMB),
    userAgent: form.userAgent,
    checkCertificate: form.checkCertificate,
    proxyEnabled: form.proxyEnabled,
    proxyServer: form.proxyServer,
    proxyUser: form.proxyUser,
    proxyPasswd: form.proxyPasswd,
    noProxy: form.noProxy,
    enableDht: form.enableDht,
    btEnableLpd: form.btEnableLpd,
    btTracker: textToTrackers(form.btTracker),
    btTrackerAutoUpdate: form.btTrackerAutoUpdate,
    seedRatio: form.seedRatio,
    seedTime: form.seedTime,
    listenPort: form.listenPort,
    btMaxPeers: form.btMaxPeers,
    upnpEnabled: form.upnpEnabled,
    streamThreadCount: form.streamThreadCount,
    streamRetryCount: form.streamRetryCount,
    streamTimeoutMs: secondsToMs(form.streamTimeoutSec),
    streamMuxAfterDownload: form.streamMuxAfterDownload,
    streamLiveRecordLimitMin: form.streamLiveRecordLimitMin,
    savePattern: form.savePattern,
    webhookUrl: form.webhookUrl,
    postScript: form.postScript,
    autoExtract: form.autoExtract,
    rpcPort: form.rpcPort,
    rpcListenAll: form.rpcListenAll,
    theme: form.theme,
    locale: form.locale,
    apiToken: form.apiToken
  }
}

// ---- 自动保存：深监听表单变化，600ms 防抖持久化（无需手动保存按钮） ----
const ready = ref(false)           // 初始填充完成前不触发保存
const justSaved = ref(false)       // 底部栏"已保存"瞬时指示
let saveTimer = null
let justSavedTimer = null
let savedForm = {}
let savePending = false

async function persistAll() {
  if (resetting.value) return
  if (saving.value) {
    savePending = true
    return
  }
  if (!isValidPort(form.listenPort) || !isValidPort(form.rpcPort)) {
    saveError.value = t('settings.portInvalid')
    return
  }
  const snapshot = buildPatch()
  const patch = Object.fromEntries(Object.entries(snapshot).filter(([key, value]) => savedForm[key] !== value))
  saveError.value = ''
  if (!Object.keys(patch).length) return
  saving.value = true
  try {
    await store.saveSettings(patch)
    savedForm = snapshot
    justSaved.value = true
    clearTimeout(justSavedTimer)
    justSavedTimer = setTimeout(() => { justSaved.value = false }, 2000)
  } catch (e) {
    saveError.value = t('settings.saveFailed', { msg: e.message })
  } finally {
    saving.value = false
    if (savePending) {
      savePending = false
      void persistAll()
    }
  }
}

onMounted(async () => {
  if (!store.loaded) {
    try { await store.fetchSettings() } catch (e) {
      ElMessage.error(t('settings.loadFailed', { msg: e.message }))
      return
    }
  }
  fillForm()
  savedForm = buildPatch()
  await nextTick()
  ready.value = true
  if (desktop) {
    try { loginAtStartup.value = (await desktop.getLoginItem()).openAtLogin } catch {}
  }
})

watch(() => store.settings.theme, theme => {
  if (!ready.value || form.theme !== savedForm.theme) return
  form.theme = theme || 'auto'
  savedForm.theme = form.theme
})

// 限速输入与预设不符时取消高亮；恰好等于某档预设时高亮该档
watch([() => form.dlLimit, () => form.ulLimit, dlUnit, ulUnit], () => {
  const d = speedDisplayToBytes(form.dlLimit, dlUnit.value)
  const u = speedDisplayToBytes(form.ulLimit, ulUnit.value)
  activeSpeedProfile.value = speedProfiles.value.findIndex(
    (p) => (p.down || 0) === d && (p.up || 0) === u
  )
})

// KB/s <-> MB/s 切换时按字节数换算当前显示值
function onUnitChange(which, newUnit) {
  if (which === 'dl') {
    form.dlLimit = bytesToSpeedDisplay(speedDisplayToBytes(form.dlLimit, dlUnit.value), newUnit)
    dlUnit.value = newUnit
  } else {
    form.ulLimit = bytesToSpeedDisplay(speedDisplayToBytes(form.ulLimit, ulUnit.value), newUnit)
    ulUnit.value = newUnit
  }
}

// 表单任一变化 → 防抖自动保存（文本框失焦/步进器提交/开关与下拉即时）
watch(
  [() => ({ ...form }), dlUnit, ulUnit],
  () => {
    if (!ready.value) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(persistAll, 600)
  },
  { deep: true }
)

async function factoryReset() {
  try {
    await ElMessageBox.confirm(t('settings.factoryResetMsg'), t('settings.factoryResetTitle'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning'
    })
  } catch {
    return
  }
  resetting.value = true
  try {
    await store.saveSettings({ ...FACTORY_DEFAULTS })
    await store.fetchSettings()
    fillForm()
    savedForm = buildPatch()
    saveError.value = ''
    ElMessage.success(t('settings.factoryResetDone'))
  } catch (e) {
    ElMessage.error(t('settings.factoryResetFailed', { msg: e.message }))
  } finally {
    resetting.value = false
  }
}

async function onRpcListenAllChange(val) {
  if (!val) return
  try {
    await ElMessageBox.confirm(t('settings.rpcListenAllConfirm'), t('settings.rpcListenAllConfirmTitle'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning'
    })
  } catch {
    form.rpcListenAll = false // 取消则回弹为关
  }
}

function insertVar(v) {
  const token = `{${v}}`
  const el = savePatternInput.value?.input
  const cur = form.savePattern || ''
  if (!el) {
    form.savePattern = cur + token
    return
  }
  const start = el.selectionStart ?? cur.length
  const end = el.selectionEnd ?? start
  form.savePattern = cur.slice(0, start) + token + cur.slice(end)
  nextTick(() => {
    el.focus()
    el.setSelectionRange(start + token.length, start + token.length)
  })
}

async function testWebhook() {
  webhookTesting.value = true
  try {
    const resp = await api.testWebhook(form.webhookUrl)
    ElMessage({
      type: resp && resp.ok ? 'success' : 'warning',
      message: t('settings.webhookTestResult', { status: resp?.status ?? '-' })
    })
  } catch (e) {
    ElMessage.error(t('settings.webhookTestFailed', { msg: e.message }))
  } finally {
    webhookTesting.value = false
  }
}

async function updateTrackers() {
  trackerUpdating.value = true
  try {
    const resp = await api.updateTrackers()
    ElMessage.success(t('settings.trackersUpdated', { count: resp.count || 0 }))
    await store.fetchSettings()
    fillForm()
  } catch (e) {
    ElMessage.error(t('settings.trackerUpdateFailed', { msg: e.message }))
  } finally {
    trackerUpdating.value = false
  }
}

async function applyProfile(index) {
  profileApplying.value = index
  try {
    await api.applySpeedProfile(index)
    activeSpeedProfile.value = index
    store.settings.activeSpeedProfile = index
    // 同步显示该预设的限速值（引擎端已即时生效；保存后才会写入设置文件）
    const p = speedProfiles.value[index] || { down: 0, up: 0 }
    dlUnit.value = 'MB'
    ulUnit.value = 'MB'
    form.dlLimit = bytesToSpeedDisplay(p.down || 0, 'MB')
    form.ulLimit = bytesToSpeedDisplay(p.up || 0, 'MB')
    ElMessage.success(t('settings.profileApplied'))
  } catch (e) {
    ElMessage.error(t('settings.profileApplyFailed', { msg: e.message }))
  } finally {
    profileApplying.value = -1
  }
}

async function copySecret() {
  secretCopying.value = true
  try {
    await navigator.clipboard.writeText(form.rpcSecret || '')
    ElMessage.success(t('settings.rpcSecretCopied'))
  } catch (e) {
    ElMessage.error(t('settings.copyFailed', { msg: e.message }))
  } finally {
    secretCopying.value = false
  }
}

function copyWsUrl() {
  const port = form.rpcPort || 16800
  const host = form.rpcListenAll ? location.hostname : '127.0.0.1'
  navigator.clipboard.writeText(`ws://${host}:${port}/jsonrpc`).catch(() => {})
  ElMessage.success(t('settings.rpcSecretCopied'))
}

async function regenerateSecret() {
  secretRegenerating.value = true
  try {
    const resp = await api.regenerateSecret()
    form.rpcSecret = resp.rpcSecret || ''
    store.settings.rpcSecret = form.rpcSecret
    ElMessage.success(t('settings.rpcSecretRegenDone'))
  } catch (e) {
    ElMessage.error(t('settings.rpcSecretRegenFailed', { msg: e.message }))
  } finally {
    secretRegenerating.value = false
  }
}
</script>

<style scoped>
.settings-view {
  min-width: 0;
  container: settings / inline-size;
}

.settings-tools {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding-bottom: 14px;
}
.settings-index { display: flex; flex-wrap: wrap; gap: 6px; }
.settings-index button {
  padding: 5px 9px;
  border: 1px solid var(--kd-border);
  border-radius: var(--kd-radius-ctrl);
  background: var(--kd-card-bg);
  color: var(--kd-text-secondary);
  font: inherit;
  font-size: var(--kd-caption);
  cursor: pointer;
}
.settings-index button:hover { color: var(--kd-primary); background: var(--kd-primary-soft); }
.settings-index button[aria-selected="true"] { color: var(--kd-on-primary); background: var(--kd-primary); border-color: var(--kd-primary); }
.save-state { font-size: var(--kd-caption); color: var(--kd-text-tertiary); overflow-wrap: anywhere; }
.save-state.save-error { color: var(--kd-danger); }
.advanced-settings { border-top: 1px solid var(--kd-border); padding-top: 12px; }
.advanced-settings summary { cursor: pointer; color: var(--kd-primary); margin-bottom: 12px; }
.app-links { display: flex; flex-wrap: wrap; gap: 14px; }
.app-links a { text-decoration: underline; text-underline-offset: 3px; }

/* 分组卡片 */
.group-card {
  min-width: 0;
  background: var(--kd-card-bg);
  border: 1px solid var(--kd-border);
  border-radius: var(--kd-radius-card);
  padding: var(--kd-space-5);
  margin-bottom: var(--kd-space-6);
  box-shadow: var(--kd-shadow-sm);
  scroll-margin-top: 8px;
}

.group-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--kd-space-2);
  margin-bottom: var(--kd-space-4);
  padding-bottom: var(--kd-space-3);
  border-bottom: 1px solid var(--kd-border-secondary);
}


.header-spacer {
  flex: 1;
}


.group-title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  color: var(--kd-text-primary);
  line-height: 1.2;
}

/* 表单项节奏与标签色 */
.settings-form :deep(.el-form-item) {
  margin-bottom: var(--kd-space-4);
}
.settings-form { min-width: 0; max-width: 100%; }
.settings-form :deep(.el-form-item__content) { min-width: 0; gap: 4px 0; }
.settings-form :deep(.el-input), .settings-form :deep(.el-select) { min-width: 0; max-width: 100%; }
.settings-form :deep(.el-input__wrapper) { min-height: 36px; }

.group-card :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}

/* Label 防截断：最小 160px、不换行、不省略 */
.settings-form :deep(.el-form-item__label) {
  min-width: 160px;
  white-space: normal;
  line-height: 1.35;
  word-break: break-word;
  overflow: visible;
  text-overflow: clip;
}

/* 数字步进器统一宽度 */
.num-stepper {
  width: 180px;
}

/* 端口纯数字输入：隐藏步进器按钮 */
.port-input {
  width: 180px;
}

.port-input :deep(input::-webkit-outer-spin-button),
.port-input :deep(input::-webkit-inner-spin-button) {
  -webkit-appearance: none;
  margin: 0;
}

.port-input :deep(input[type='number']) {
  -moz-appearance: textfield;
  appearance: textfield;
}

/* 限速输入 + 单位切换 */
.speed-field {
  display: flex;
  align-items: center;
  gap: var(--kd-space-2);
  flex-wrap: wrap;
}

.unit-suffix {
  margin-left: var(--kd-space-2);
  font-size: var(--kd-caption);
  color: var(--kd-text-muted);
}

.ws-copy { padding: 0 4px; height: auto; font-size: var(--kd-caption); }
.ws-copy:hover { color: var(--kd-primary); }

.hint {
  margin-left: var(--kd-space-3);
  font-size: var(--kd-caption);
  color: var(--kd-text-tertiary);
}

.hint-block {
  margin-left: 0;
  display: block;
  width: 100%;
  line-height: 1.6;
}

/* 代理联动：关闭时整组禁用并半透明 */
.proxy-fields {
  transition: opacity 150ms ease;
}

.proxy-fields.proxy-off {
  opacity: 0.5;
}

/* Tracker：等宽、每行一个、横向滚动 */
.tracker-input {
  width: 100%;
}

.tracker-input :deep(textarea) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace;
  font-size: var(--kd-caption);
  line-height: 1.7;
}

.tracker-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: var(--kd-space-2);
  flex-wrap: wrap;
  gap: 8px;
}

.profile-bar {
  display: flex;
  gap: var(--kd-space-2);
  flex-wrap: wrap;
}

.secret-bar {
  display: flex;
  align-items: center;
  gap: var(--kd-space-2);
  width: 100%;
  min-width: 0;
}

.webhook-bar {
  display: flex;
  align-items: center;
  gap: var(--kd-space-2);
  width: 100%;
  min-width: 0;
}
.secret-bar > .el-input, .webhook-bar > .el-input { flex: 1; }
.secret-bar > .el-button, .webhook-bar > .el-button { flex-shrink: 0; }

/* 模板变量胶囊 */
.var-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--kd-space-2);
  margin-top: var(--kd-space-2);
}

.var-tag {
  cursor: pointer;
  user-select: none;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace;
}

/* 吸底保存栏（毛玻璃） */
.factory-btn {
  margin-left: auto;
  color: var(--kd-text-muted);
}

.factory-btn:hover {
  color: var(--kd-danger);
  background: var(--kd-danger-soft);
}

@container settings (max-width: 700px) {
  .group-card { padding: var(--kd-space-4); }
  .settings-form :deep(.el-form-item) { display: block; }
  .settings-form :deep(.el-form-item__label) {
    justify-content: flex-start;
    width: auto !important;
    height: auto;
    padding: 0 0 6px;
  }
  .settings-form :deep(.el-select) { max-width: 100%; }
  .secret-bar, .webhook-bar { flex-wrap: wrap; }
  .hint { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .anchor-pill,
  .proxy-fields {
    transition: none;
  }
}
</style>
