// REST API client. Same-origin /api/v1 (vite proxy forwards to 127.0.0.1:16801 in dev).

let authToken = ''
try { authToken = sessionStorage.getItem('rdown:api-token') || '' } catch {}
export function getAuthToken() { return authToken }

export function setAuthToken(token) {
  authToken = token || ''
  try {
    if (authToken) sessionStorage.setItem('rdown:api-token', authToken)
    else sessionStorage.removeItem('rdown:api-token')
  } catch {}
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`
  const resp = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      if (data && (data.error || data.message)) msg = data.error || data.message
    } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: resp.status })
  }
  if (resp.status === 204) return null
  return resp.json()
}

export const api = {
  health: () => request('GET', '/health'),
  resolve: (url, headers) => request('POST', '/resolve', { url, headers }),
  createTask: (payload) => request('POST', '/tasks', payload),
  getTasks: (status = 'all') => request('GET', `/tasks?status=${status}`),
  getTask: (engine, id) => request('GET', `/tasks/${engine}/${encodeURIComponent(id)}`),
  taskAction: (engine, id, action, deleteFiles = false) =>
    request('POST', `/tasks/${engine}/${encodeURIComponent(id)}/action`, { action, deleteFiles }),
  pauseAll: () => request('POST', '/tasks/pause-all'),
  resumeAll: () => request('POST', '/tasks/resume-all'),
  clearCompleted: () => request('POST', '/tasks/clear-completed'),
  getStats: () => request('GET', '/stats'),
  getSettings: () => request('GET', '/settings'),
  saveSettings: (patch) => request('PUT', '/settings', patch),
  updateTrackers: () => request('POST', '/trackers/update'),
  regenerateSecret: () => request('POST', '/settings/regenerate-secret'),
  applySpeedProfile: (index) => request('POST', '/speed-profiles/apply', { index }),
  testWebhook: (url) => request('POST', '/hooks/test', { url }),
  reveal: (path) => request('POST', '/reveal', { path })
}
