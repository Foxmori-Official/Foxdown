<template>
  <div class="task-row">
    <div class="task-icon" :class="task.kind">
      <el-icon :size="20">
        <Folder v-if="task.kind === 'torrent'" />
        <VideoPlay v-else-if="task.kind === 'stream'" />
        <Document v-else />
      </el-icon>
    </div>

    <div class="task-main">
      <div class="task-title-row">
        <span class="task-name" :title="task.name">{{ task.name || t('taskrow.unnamed') }}</span>
        <el-tag :type="statusTagType" size="small" disable-transitions>
          {{ statusText(task.status) }}
        </el-tag>
        <el-tag v-if="task.kind === 'stream' && task.streamMeta" size="small" type="warning" disable-transitions>
          {{ (task.streamMeta.format || '').toUpperCase() }}{{ task.streamMeta.live ? ' ' + t('common.live') : '' }}
        </el-tag>
      </div>

      <el-progress
        :percentage="percent"
        :status="progressStatus"
        :stroke-width="6"
        class="task-progress"
      />

      <div class="task-meta">
        <span>{{ formatBytes(task.completedLength) }} / {{ totalSizeText }}</span>
        <span v-if="isRunning">{{ formatSpeed(speed) }}</span>
        <span v-if="etaText">{{ t('taskrow.remaining', { eta: etaText }) }}</span>
        <span v-if="task.connections">{{ t('taskrow.connections', { n: task.connections }) }}</span>
        <span v-if="task.kind === 'torrent' && (task.uploadSpeed || task.numSeeders)" class="bt-info">
          {{ t('taskrow.btInfo', { speed: formatSpeed(task.uploadSpeed), n: task.numSeeders || 0 }) }}
        </span>
        <span v-if="task.kind === 'stream' && task.progress && task.progress.totalSegments">
          {{ t('taskrow.segments', { done: task.progress.doneSegments, total: task.progress.totalSegments }) }}
        </span>
        <span v-if="task.status === 'error' && task.errorMessage" class="error-text" :title="task.errorMessage">
          {{ task.errorMessage }}
        </span>
      </div>
    </div>

    <div class="task-actions">
      <el-tooltip v-if="canPause" :content="t('taskrow.pause')" placement="top">
        <el-button circle size="small" :aria-label="t('taskrow.pause')" @click="doAction('pause')">
          <el-icon><VideoPause /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip v-if="canResume" :content="t('taskrow.resume')" placement="top">
        <el-button circle size="small" type="primary" :aria-label="t('taskrow.resume')" @click="doAction('resume')">
          <el-icon><VideoPlay /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip v-if="canRetry" :content="t('taskrow.retry')" placement="top">
        <el-button circle size="small" type="warning" :aria-label="t('taskrow.retry')" @click="doAction('retry')">
          <el-icon><RefreshRight /></el-icon>
        </el-button>
      </el-tooltip>
      <el-tooltip :content="t('taskrow.reveal')" placement="top">
        <el-button circle size="small" :aria-label="t('taskrow.reveal')" @click="doReveal">
          <el-icon><FolderOpened /></el-icon>
        </el-button>
      </el-tooltip>
      <el-dropdown trigger="click" @command="onDeleteCommand">
        <el-button circle size="small" type="danger" plain :aria-label="t('taskrow.deleteTask')">
          <el-icon><Delete /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="task">{{ t('taskrow.deleteTask') }}</el-dropdown-item>
            <el-dropdown-item command="files">{{ t('taskrow.deleteTaskFiles') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<script setup>
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon, ElProgress, ElTag, ElTooltip } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/dropdown/style/css'
import 'element-plus/es/components/dropdown-item/style/css'
import 'element-plus/es/components/dropdown-menu/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/progress/style/css'
import 'element-plus/es/components/tag/style/css'
import 'element-plus/es/components/tooltip/style/css'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useTasksStore } from '../stores/tasks'
import {
  formatBytes,
  formatSpeed,
  formatEta,
  taskPercent,
  taskSpeed,
  statusText,
  STATUS_TAG_TYPE,
  ACTIVE_STATUSES
} from '../utils/format'

const { t } = useI18n()

const props = defineProps({
  task: { type: Object, required: true }
})

const store = useTasksStore()

const percent = computed(() => Math.min(100, Math.round(taskPercent(props.task) * 10) / 10))
const speed = computed(() => taskSpeed(props.task))

const totalSizeText = computed(() => {
  if (props.task.kind === 'stream' && !props.task.totalLength) return t('taskrow.unknownSize')
  return formatBytes(props.task.totalLength)
})

const isRunning = computed(() =>
  ['active', 'downloading', 'muxing'].includes(props.task.status)
)

const etaText = computed(() => {
  if (!isRunning.value) return ''
  if (props.task.kind === 'stream' && props.task.progress && props.task.progress.eta) {
    return formatEta(props.task.progress.eta)
  }
  const remain = Number(props.task.totalLength) - Number(props.task.completedLength)
  if (remain > 0 && speed.value > 0) return formatEta(remain / speed.value)
  return ''
})

const progressStatus = computed(() => {
  if (props.task.status === 'error' || props.task.status === 'cancelled') return 'exception'
  if (props.task.status === 'complete') return 'success'
  if (props.task.status === 'paused') return 'warning'
  return ''
})

const statusTagType = computed(() => STATUS_TAG_TYPE[props.task.status] || 'info')

const canPause = computed(() => ACTIVE_STATUSES.includes(props.task.status))
const canResume = computed(() => props.task.status === 'paused')
const canRetry = computed(() => ['error', 'removed', 'cancelled'].includes(props.task.status))

async function doAction(action) {
  try {
    if (action === 'pause') await store.pauseTask(props.task)
    else if (action === 'resume') await store.resumeTask(props.task)
    else if (action === 'retry') await store.retryTask(props.task)
  } catch (e) {
    ElMessage.error(t('taskrow.actionFailed', { msg: e.message }))
  }
}

async function doReveal() {
  try {
    await store.reveal(props.task)
  } catch (e) {
    ElMessage.error(t('taskrow.revealFailed', { msg: e.message }))
  }
}

async function onDeleteCommand(cmd) {
  const withFiles = cmd === 'files'
  try {
    await ElMessageBox.confirm(
      withFiles
        ? t('taskrow.deleteFilesMsg', { name: props.task.name })
        : t('taskrow.deleteMsg', { name: props.task.name }),
      t('taskrow.deleteTitle'),
      { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  try {
    await store.deleteTask(props.task, withFiles)
    ElMessage.success(t('taskrow.deleted'))
  } catch (e) {
    ElMessage.error(t('taskrow.deleteFailed', { msg: e.message }))
  }
}
</script>

<style scoped>
.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--kd-border);
  border-radius: var(--kd-radius-card);
  background: var(--kd-card-bg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.task-row:hover {
  border-color: var(--kd-primary-border);
  box-shadow: var(--kd-shadow-hover);
}

.task-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--kd-radius-icon);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kd-primary);
  background: var(--kd-primary-soft);
}

.task-icon.torrent { color: var(--kd-success); background: var(--kd-success-soft); }
.task-icon.stream { color: var(--kd-warning); background: var(--kd-warning-soft); }

.task-main {
  flex: 1;
  min-width: 0;
}

.task-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.task-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--kd-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 22px;
}

.task-progress {
  margin-bottom: 6px;
}

.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--kd-text-tertiary);
  font-variant-numeric: tabular-nums;
  line-height: 18px;
}

.bt-info {
  color: var(--kd-success);
}

.error-text {
  color: var(--kd-danger);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  /* 定宽使所有行的进度条右端锚定同一 x，消除状态切换时的锯齿 */
  min-width: 180px;
}

.task-actions :deep(.el-button + .el-button) { margin-left: 0; }

@media (max-width: 700px) {
  .task-row { flex-wrap: wrap; padding: 12px; }
  .task-actions { min-width: 0; width: 100%; }
  .task-meta { gap: 4px 10px; }
  .error-text { max-width: 100%; }
}
</style>
