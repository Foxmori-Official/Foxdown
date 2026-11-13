import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import { api } from '../api/client'
import i18n from '../i18n'
import {
  ACTIVE_STATUSES,
  COMPLETE_STATUSES,
  STOPPED_STATUSES
} from '../utils/format'

const MAX_BACKOFF = 15000

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: [],
    stats: { downloadSpeed: 0, uploadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 0 },
    connected: false,
    everConnected: false,
    reconnecting: false,
    // WS 内部状态
    _ws: null,
    _backoff: 1000,
    _reconnectTimer: null,
    _token: ''
  }),
  getters: {
    activeTasks: (state) => state.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)),
    completeTasks: (state) => state.tasks.filter((t) => COMPLETE_STATUSES.includes(t.status)),
    stoppedTasks: (state) => state.tasks.filter((t) => STOPPED_STATUSES.includes(t.status))
  },
  actions: {
    connect(token = '') {
      this._token = token
      this._teardown()
      this.connected = false
      this.reconnecting = false
      this._open()
    },
    reconnectWithToken(token) {
      if (token !== this._token) this.connect(token)
    },
    _teardown() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      if (this._ws) {
        this._ws.onclose = null
        this._ws.onmessage = null
        this._ws.onerror = null
        this._ws.onopen = null
        try { this._ws.close() } catch { /* ignore */ }
        this._ws = null
      }
    },
    _open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      let url = `${proto}://${location.host}/ws`
      if (this._token) url += `?token=${encodeURIComponent(this._token)}`
      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        this._scheduleReconnect()
        return
      }
      this._ws = ws
      ws.onopen = () => {
        this.connected = true
        this.everConnected = true
        this.reconnecting = false
        this._backoff = 1000
      }
      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'state') {
          this.tasks = Array.isArray(msg.tasks) ? msg.tasks : []
          if (msg.stats) this.stats = msg.stats
        } else if (msg.type === 'event') {
          this._handleEvent(msg)
        }
      }
      ws.onclose = () => {
        this.connected = false
        this._scheduleReconnect()
      }
      ws.onerror = () => {
        // onclose 会随后触发，统一在那里重连
      }
    },
    _scheduleReconnect() {
      this.reconnecting = true
      if (this._reconnectTimer) return
      const delay = this._backoff
      this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF)
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null
        this._open()
      }, delay)
    },
    _handleEvent(msg) {
      const task = this.tasks.find((t) => t.id === msg.gid)
      const name = task ? task.name : msg.gid
      switch (msg.name) {
        case 'onDownloadComplete':
          ElMessage.success(i18n.global.t('tasks.notifyComplete', { name }))
          break
        case 'onDownloadError':
          ElMessage.error(i18n.global.t('tasks.notifyError', { name }))
          break
        case 'onBtComplete':
          ElMessage.success(i18n.global.t('tasks.notifyBtComplete', { name }))
          break
        default:
          break
      }
    },
    // ---- 任务操作 ----
    async pauseTask(task) {
      await api.taskAction(task.engine, task.id, 'pause')
    },
    async resumeTask(task) {
      await api.taskAction(task.engine, task.id, 'resume')
    },
    async retryTask(task) {
      await api.taskAction(task.engine, task.id, 'retry')
    },
    async deleteTask(task, deleteFiles = false) {
      await api.taskAction(task.engine, task.id, 'delete', deleteFiles)
    },
    async pauseAll() {
      await api.pauseAll()
    },
    async resumeAll() {
      await api.resumeAll()
    },
    async clearCompleted() {
      return api.clearCompleted()
    },
    async reveal(task) {
      await api.reveal(task.dir)
    }
  }
})
