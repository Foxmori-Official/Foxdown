<template>
  <div class="tasks-view">
    <dl class="stats" :class="{ idle: !store.stats.numActive }">
      <div class="stat">
        <dt><el-icon><Download /></el-icon>{{ t('tasks.downloadSpeed') }}</dt>
        <dd>{{ formatSpeed(store.stats.downloadSpeed) }}</dd>
      </div>
      <div class="stat">
        <dt><el-icon><Upload /></el-icon>{{ t('tasks.uploadSpeed') }}</dt>
        <dd>{{ formatSpeed(store.stats.uploadSpeed) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('tasks.activeCount') }}</dt>
        <dd>{{ store.stats.numActive || 0 }}</dd>
      </div>
    </dl>

    <div class="task-toolbar">
      <el-tabs v-model="tab" class="task-tabs">
        <el-tab-pane v-for="t in tabs" :key="t.key" :name="t.key">
          <template #label>
            {{ t.label }}
            <el-badge
              v-if="t.count"
              :value="t.count"
              :max="999"
              type="info"
              class="tab-badge"
            />
          </template>
        </el-tab-pane>
      </el-tabs>
      <div class="actions">
        <el-button
          v-if="store.completeTasks.length || clearingCompleted"
          :disabled="!store.connected"
          :loading="clearingCompleted"
          @click="onClearCompleted"
        >
          {{ t('tasks.clearCompleted') }}
        </el-button>
        <el-button @click="onPauseAll" :disabled="!store.activeTasks.length">{{ t('tasks.pauseAll') }}</el-button>
        <el-button @click="onResumeAll" :disabled="!store.tasks.some(t => t.status === 'paused')">{{ t('tasks.resumeAll') }}</el-button>
        <el-button type="primary" @click="newTaskVisible = true">
          <el-icon><Plus /></el-icon>{{ t('tasks.newTask') }}
        </el-button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div v-if="filteredTasks.length" class="task-list">
      <TaskRow v-for="task in filteredTasks" :key="task.engine + '-' + task.id" :task="task" />
    </div>
    <div v-else class="empty-state">
      <div class="empty-icon">
        <el-icon :size="28"><Download /></el-icon>
      </div>
      <h2 class="empty-title">{{ emptyText }}</h2>
      <p class="empty-hint">{{ t('tasks.emptyHint') }}</p>
    </div>

    <NewTaskDialog v-if="newTaskVisible" v-model="newTaskVisible" />
  </div>
</template>

<script setup>
import { ElBadge, ElButton, ElIcon, ElMessage, ElMessageBox, ElTabPane, ElTabs } from 'element-plus'
import 'element-plus/es/components/badge/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/tab-pane/style/css'
import 'element-plus/es/components/tabs/style/css'

import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTasksStore } from '../stores/tasks'
import { formatSpeed } from '../utils/format'
const TaskRow = defineAsyncComponent(() => import('../components/TaskRow.vue'))
const NewTaskDialog = defineAsyncComponent(() => import('../components/NewTaskDialog.vue'))

const { t } = useI18n()
const store = useTasksStore()
const tab = ref('all')
const newTaskVisible = ref(false)
const clearingCompleted = ref(false)
let confirmingClear = false

const tabs = computed(() => [
  { key: 'all', label: t('tasks.tabAll'), count: 0 },
  { key: 'active', label: t('tasks.tabActive'), count: store.activeTasks.length },
  { key: 'complete', label: t('tasks.tabComplete'), count: store.completeTasks.length },
  { key: 'stopped', label: t('tasks.tabStopped'), count: store.stoppedTasks.length }
])

const filteredTasks = computed(() => {
  switch (tab.value) {
    case 'active': return store.activeTasks
    case 'complete': return store.completeTasks
    case 'stopped': return store.stoppedTasks
    default: return store.tasks
  }
})

const emptyText = computed(() =>
  store.connected ? t('tasks.empty') : t(store.reconnecting ? 'common.connectionReconnectStatus' : 'tasks.connectingBackend')
)

async function onPauseAll() {
  try {
    await store.pauseAll()
  } catch (e) {
    ElMessage.error(t('tasks.pauseAllFailed', { msg: e.message }))
  }
}

async function onResumeAll() {
  try {
    await store.resumeAll()
  } catch (e) {
    ElMessage.error(t('tasks.resumeAllFailed', { msg: e.message }))
  }
}

async function onClearCompleted() {
  if (confirmingClear || clearingCompleted.value || !store.completeTasks.length) return
  confirmingClear = true
  try {
    await ElMessageBox.confirm(t('tasks.clearCompletedConfirm'), t('tasks.clearCompleted'), {
      type: 'warning',
      confirmButtonText: t('tasks.clearCompletedAction'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  } finally {
    confirmingClear = false
  }
  clearingCompleted.value = true
  try {
    const { removed, failed } = await store.clearCompleted()
    if (failed) ElMessage.warning(t('tasks.clearCompletedPartial', { removed, failed }))
    else ElMessage.success(t('tasks.clearCompletedDone', { count: removed }))
  } catch (error) {
    ElMessage.error(t('tasks.clearCompletedFailed', { msg: error.message }))
  } finally {
    clearingCompleted.value = false
  }
}
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 18px 0;
  margin: 0 0 20px;
  border-radius: var(--kd-radius-card);
  background: var(--kd-summary-bg);
  color: var(--kd-summary-ink);
}

.stats.idle {
  background: var(--kd-card-bg);
  border: 1px solid var(--kd-border);
  color: var(--kd-text-primary);
}
.stats.idle .stat + .stat { border-color: var(--kd-border); }
.stats.idle .stat dt { color: var(--kd-text-tertiary); }
.tab-badge :deep(.el-badge__content) {
  background: var(--kd-primary-soft);
  color: var(--kd-primary);
}

.stat {
  min-width: 0;
  padding-inline: clamp(12px, 2.4vw, 26px);
}

.stat + .stat { border-left: 1px solid var(--kd-summary-line); }

.stat dt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--kd-caption);
  color: var(--kd-summary-muted);
  overflow-wrap: anywhere;
}

.stat dd {
  margin: 8px 0 0;
  font: 550 clamp(16px, 2vw, 25px)/1.25 var(--kd-mono);
  letter-spacing: -0.045em;
  overflow-wrap: anywhere;
}

.task-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--kd-border);
}

.task-tabs {
  min-width: 0;
  max-width: 100%;
}

.task-tabs :deep(.el-tabs__header) { margin: 0; }
.task-tabs :deep(.el-tabs__nav-wrap::after) { content: none; }
.task-tabs :deep(.el-tabs__item) { padding-inline: 10px; }
.task-tabs :deep(.el-tabs__item:first-child) { padding-inline-start: 0; }
.task-tabs :deep(.el-tabs__item:last-child) { padding-inline-end: 0; }
.tab-badge { margin-inline-start: 6px; }

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-block: 5px;
}

.actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
.actions :deep(.el-icon), .empty-state :deep(.el-button .el-icon) { margin-inline-end: 5px; }

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-state {
  display: grid;
  justify-items: center;
  align-content: center;
  min-height: 252px;
  padding: 32px 18px;
  border: 1px solid var(--kd-border);
  border-radius: var(--kd-radius-card);
  background: var(--kd-card-bg);
  text-align: center;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin: 10px 0 24px;
  border: 1px solid var(--kd-primary-border);
  border-radius: 16px;
  background: var(--kd-primary-soft);
  color: var(--kd-primary);
  box-shadow: 0 0 0 9px var(--kd-secondary-bg);
}

.empty-title {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 650;
}

.empty-hint {
  max-width: 48ch;
  margin: 0 0 20px;
  font-size: var(--kd-meta);
  line-height: 1.6;
  color: var(--kd-text-tertiary);
}

@media (max-width: 700px) {
  .stats { margin-bottom: 12px; padding-block: 14px; }
  .stat { padding-inline: clamp(8px, 2.8vw, 16px); }
  .stat dt { font-size: 11px; }
  .stat dt .el-icon { display: none; }
  .stat dd { font-size: clamp(12px, 3.5vw, 15px); }
  .task-toolbar { gap: 0; padding-bottom: 7px; }
  .task-tabs { width: 100%; }
  .actions { justify-content: flex-start; }
  .empty-state { min-height: 240px; }
}
</style>
