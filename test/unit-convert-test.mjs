// 设置页单位双向换算测试：web/src/utils/units.js（Load/Save 层换算，存储格式不变）
import assert from 'node:assert/strict'
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
} from '../web/src/utils/units.js'

let n = 0
function ok(name, fn) {
  fn()
  n++
  console.log(`✓ ${name}`)
}

// ---- 限速：字节/秒 <-> MB/s、KB/s ----
ok('1048576 B/s -> 1 MB/s', () => assert.equal(bytesToSpeedDisplay(1048576, 'MB'), 1))
ok('1 MB/s -> 1048576 B/s', () => assert.equal(speedDisplayToBytes(1, 'MB'), 1048576))
ok('10 MB/s -> 10485760 B/s（夜间模式）', () => assert.equal(speedDisplayToBytes(10, 'MB'), 10485760))
ok('2097152 B/s -> 2 MB/s（办公模式）', () => assert.equal(bytesToSpeedDisplay(2097152, 'MB'), 2))
ok('2048 B/s -> 2 KB/s', () => assert.equal(bytesToSpeedDisplay(2048, 'KB'), 2))
ok('2 KB/s -> 2048 B/s', () => assert.equal(speedDisplayToBytes(2, 'KB'), 2048))
ok('0 B/s -> 0（不限速）', () => assert.equal(bytesToSpeedDisplay(0, 'MB'), 0))
ok('UI 0 -> 存储 0（不限速）', () => assert.equal(speedDisplayToBytes(0, 'MB'), 0))
ok('负数/NaN 归 0', () => {
  assert.equal(speedDisplayToBytes(-5, 'MB'), 0)
  assert.equal(bytesToSpeedDisplay(NaN, 'MB'), 0)
})
ok('MB 显示保留 2 位小数', () => assert.equal(bytesToSpeedDisplay(1572864, 'MB'), 1.5))
ok('MB/s 往返：2.5 -> 2621440 -> 2.5', () => {
  const b = speedDisplayToBytes(2.5, 'MB')
  assert.equal(b, 2621440)
  assert.equal(bytesToSpeedDisplay(b, 'MB'), 2.5)
})

// ---- 流媒体超时：ms <-> s ----
ok('30000 ms -> 30 s', () => assert.equal(msToSeconds(30000), 30))
ok('30 s -> 30000 ms', () => assert.equal(secondsToMs(30), 30000))
ok('20000 ms -> 20 s（后端默认值）', () => assert.equal(msToSeconds(20000), 20))
ok('0/负值归 0', () => {
  assert.equal(msToSeconds(0), 0)
  assert.equal(secondsToMs(-1), 0)
})

// ---- 容量字符串：'NM'/'0' <-> MB 数值 ----
ok("'1M' -> 1", () => assert.equal(sizeStrToMB('1M'), 1))
ok("1 -> '1M'", () => assert.equal(mbToSizeStr(1), '1M'))
ok("'64M' -> 64（后端默认值）", () => assert.equal(sizeStrToMB('64M'), 64))
ok("64 -> '64M'", () => assert.equal(mbToSizeStr(64), '64M'))
ok("'0' -> 0", () => assert.equal(sizeStrToMB('0'), 0))
ok("0 -> '0'（边界：0 存 '0'）", () => assert.equal(mbToSizeStr(0), '0'))
ok("负数/空 -> '0' / 0", () => {
  assert.equal(mbToSizeStr(-1), '0')
  assert.equal(sizeStrToMB(''), 0)
  assert.equal(sizeStrToMB(null), 0)
})
ok("小写 '16m' 也解析", () => assert.equal(sizeStrToMB('16m'), 16))

// ---- Tracker：逗号分隔 <-> 每行一个 ----
ok("'a,b' -> 'a\\nb'", () => assert.equal(trackersToText('udp://a,udp://b'), 'udp://a\nudp://b'))
ok("换行+逗号混合分割、去空去重", () =>
  assert.equal(textToTrackers('udp://a\nudp://b,udp://a\n\n udp://c '), 'udp://a,udp://b,udp://c'))
ok("空串互转", () => {
  assert.equal(trackersToText(''), '')
  assert.equal(textToTrackers(''), '')
})
ok("往返：'a,b,c' 不变", () =>
  assert.equal(textToTrackers(trackersToText('udp://a,udp://b,udp://c')), 'udp://a,udp://b,udp://c'))

// ---- 端口校验 ----
ok('1 与 65535 合法', () => {
  assert.equal(isValidPort(1), true)
  assert.equal(isValidPort(65535), true)
})
ok('0 / 65536 / 小数 / NaN 非法', () => {
  assert.equal(isValidPort(0), false)
  assert.equal(isValidPort(65536), false)
  assert.equal(isValidPort(1.5), false)
  assert.equal(isValidPort('abc'), false)
})
ok('clampPort 收敛到 1~65535', () => {
  assert.equal(clampPort(0, 51413), 1)
  assert.equal(clampPort(70000, 51413), 65535)
  assert.equal(clampPort('abc', 51413), 51413)
  assert.equal(clampPort(16800), 16800)
})

console.log(`\n结果: ${n} 项断言全部通过`)
