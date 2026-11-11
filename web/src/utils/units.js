// Unit bidirectional conversion: settings form UI display layer <-> backend storage format.
// Iron rule: storage formats never change (bytes/sec number, ms number, 'NM'/'0' strings,
// comma-separated trackers); all conversion happens only at form Load / Save.
// Pure functions, no Vue dependency, directly importable by node tests.

export const BYTES_PER_KB = 1024
export const BYTES_PER_MB = 1048576

// ---- Speed limits: stored number(bytes/s) <-> UI number ('MB' = MB/s, 'KB' = KB/s) ----
export function bytesToSpeedDisplay(bytes, unit = 'MB') {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (unit === 'KB') return Math.round(n / BYTES_PER_KB)
  // MB/s keeps at most 2 decimals, avoiding 102400 -> 0.09765625 long tails
  return Math.round((n / BYTES_PER_MB) * 100) / 100
}

export function speedDisplayToBytes(value, unit = 'MB') {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * (unit === 'KB' ? BYTES_PER_KB : BYTES_PER_MB))
}

// ---- Stream timeout: stored ms <-> UI seconds ----
export function msToSeconds(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n / 1000)
}

export function secondsToMs(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 1000)
}

// ---- Size strings: stored '64M' / '0' <-> UI MB number ----
export function sizeStrToMB(str) {
  if (str === null || str === undefined) return 0
  const s = String(str).trim()
  if (!s || s === '0') return 0
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KkMmGg])$/)
  if (m) {
    const v = Number(m[1])
    const u = m[2].toUpperCase()
    if (u === 'G') return v * 1024
    if (u === 'M') return v
    return Math.round((v / 1024) * 100) / 100 // K -> MB
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

export function mbToSizeStr(mb) {
  const n = Number(mb)
  if (!Number.isFinite(n) || n <= 0) return '0'
  return `${Math.round(n)}M`
}

// ---- Tracker list: stored comma-separated <-> UI one-per-line ----
export function trackersToText(str) {
  if (!str) return ''
  return String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
}

// Accepts newline or comma separators; dedupes and joins with commas
export function textToTrackers(text) {
  if (!text) return ''
  const parts = String(text)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(parts)].join(',')
}

// ---- Ports: integer validation 1~65535 ----
export function isValidPort(p) {
  const n = Number(p)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function clampPort(p, fallback = 0) {
  const n = Math.round(Number(p))
  if (!Number.isFinite(n)) return fallback
  return Math.min(65535, Math.max(1, n))
}
