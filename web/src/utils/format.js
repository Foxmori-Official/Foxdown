// 格式化工具函数
import i18n from '../i18n'

function t(key, params) {
  return i18n.global.t(key, params || {})
}

export function formatBytes(bytes, digits = 2) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1)
  const v = n / Math.pow(1024, i)
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function formatSpeed(bytesPerSec) {
  const n = Number(bytesPerSec)
  if (!Number.isFinite(n) || n <= 0) return '0 B/s'
  return `${formatBytes(n)}/s`
}

export function formatEta(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 60) return t('common.etaSeconds', { s: Math.round(s) })
  if (s < 3600) return t('common.etaMinutes', { m: Math.floor(s / 60), s: Math.round(s % 60) })
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return t('common.etaHours', { h, m })
}

// 任务进度百分比（0-100）
export function taskPercent(task) {
  if (task.kind === 'stream' && task.progress) {
    const { totalSegments, doneSegments } = task.progress
    if (totalSegments > 0) return (doneSegments / totalSegments) * 100
    return 0
  }
  const total = Number(task.totalLength)
  if (total > 0) return (Number(task.completedLength) / total) * 100
  return 0
}

// 任务下载速度（流媒体优先用 progress.speed）
export function taskSpeed(task) {
  if (task.kind === 'stream' && task.progress && task.progress.speed) {
    return task.progress.speed
  }
  return task.downloadSpeed || 0
}

const STATUS_KEYS = [
  'active', 'waiting', 'paused', 'error', 'complete',
  'removed', 'downloading', 'muxing', 'cancelled'
]

export const STATUS_TAG_TYPE = {
  active: 'primary',
  waiting: 'info',
  paused: 'warning',
  error: 'danger',
  complete: 'success',
  removed: 'info',
  downloading: 'primary',
  muxing: 'primary',
  cancelled: 'info'
}

const KIND_KEYS = ['file', 'torrent', 'stream']

// 状态分组
export const ACTIVE_STATUSES = ['active', 'downloading', 'muxing', 'waiting']
export const COMPLETE_STATUSES = ['complete']
export const STOPPED_STATUSES = ['paused', 'error', 'removed', 'cancelled']

export function statusText(s) {
  if (STATUS_KEYS.includes(s)) return t(`common.status.${s}`)
  return s
}

export function kindText(k) {
  if (KIND_KEYS.includes(k)) return t(`common.kind.${k}`)
  return k
}
