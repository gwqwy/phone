import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSE_DESKTOP_GONE,
  CLOSE_REPAIR,
  CLOSE_TAKEOVER,
  CLOSE_TRANSIENT,
  LED_ERROR,
  LED_LIVE,
  LED_LOADING,
  TERMINAL_REASONS,
  classifyClose,
  isTakeoverCode,
  isTerminalClose,
  isTerminalReason,
  onFrameRoot,
  onSocketEvent,
  pageFailureIsConnectionError,
} from '../client/core/relay-led.js'

test('未知错误码是终态（宁可多报一次，也不要静默地装死）', () => {
  assert.equal(onFrameRoot({ type: 'error', code: 'SOMETHING_NEW' }), LED_ERROR)
  assert.equal(onFrameRoot({ type: 'error' }), LED_ERROR)
})

test('收到 data 帧即认为连接正常（比 socket open 更可靠）', () => {
  assert.equal(onFrameRoot({ type: 'data', payload: {} }), LED_LIVE)
})

test('可恢复错误码不改变状态灯', () => {
  assert.equal(onFrameRoot({ type: 'error', code: 'DEVICE_OFFLINE' }), null)
  assert.equal(onFrameRoot({ type: 'error', code: 'INTERNAL' }), null)
  assert.equal(onFrameRoot({ type: 'error', code: 'device_offline' }), null, '大小写不敏感')
})

test('四类关闭必须分开：被接管 ≠ 配对失效', () => {
  // 真机反馈「链接没有改，但连接不上」——因为另一个客户端占着设备（SessionConflict 4009）
  // 被我们报成了「配对已失效」。用户当然会反驳：他的链接一点问题都没有。
  assert.equal(classifyClose(4009, ''), CLOSE_TAKEOVER, 'SessionConflict = 被别的客户端占着')
  assert.equal(classifyClose(0, 'kicked'), CLOSE_TAKEOVER)

  assert.equal(classifyClose(4010, ''), CLOSE_DESKTOP_GONE, 'DesktopDisconnected = 电脑端远控页面关了')
  assert.equal(classifyClose(4012, ''), CLOSE_DESKTOP_GONE, 'WorkspaceClosed')
  assert.equal(classifyClose(0, 'desktop-disconnected'), CLOSE_DESKTOP_GONE)

  assert.equal(classifyClose(4004, ''), CLOSE_REPAIR, 'SessionNotFound = 真的要从新配对')
  assert.equal(classifyClose(4011, ''), CLOSE_REPAIR, 'SessionExpired')
  assert.equal(classifyClose(4013, ''), CLOSE_REPAIR, 'InvalidMobileConnection')

  assert.equal(classifyClose(1006, ''), CLOSE_TRANSIENT, '网络断了只是暂时的')
  assert.equal(classifyClose(1000, ''), CLOSE_TRANSIENT)
  assert.equal(classifyClose(0, ''), CLOSE_TRANSIENT, '拿不准的一律算暂时')

  // 只有"真的要重新配对"才算终态
  assert.equal(isTerminalClose(4004, ''), true)
  assert.equal(isTerminalClose(4009, ''), false, '被接管不该逼用户重新扫码')
  assert.equal(isTerminalClose(4010, ''), false, '电脑端离线等它回来就行')
  assert.equal(isTerminalClose(1006, ''), false)
})

// 旧的 orphan 断言（isTerminalClose 把 desktop-disconnected 也算终态）已随归类拆解删除，
// 新行为由上面那条"四类关闭必须分开"覆盖。

test('只给通用关闭码时不显示"配对已失效"，交给自动重连', () => {
  assert.equal(isTerminalReason(''), false)
  assert.equal(onSocketEvent({ kind: 'closed', code: 1006, reason: '' }), LED_LOADING)
  assert.equal(onSocketEvent({ kind: 'closed', code: 4011, reason: '' }), LED_ERROR)
})

test('被接管不是终态：配对是好的，只是此刻轮不到我们', () => {
  // 官方远控页面与 shou 共用同一个 sid，会把我们挤掉。把这种情况报成"配对已失效"
  // 会误导用户去重新扫码，而他真正要做的只是关掉浏览器里的那个页面。
  assert.equal(onFrameRoot({ type: 'error', code: 'KICKED' }), null)
  assert.equal(onFrameRoot({ type: 'error', code: 'kicked' }), null)
  assert.equal(isTakeoverCode('KICKED'), true)
  assert.equal(isTakeoverCode('KickEd'), true)
  assert.equal(isTakeoverCode('SOMETHING_NEW'), false)
  assert.equal(
    TERMINAL_REASONS.includes('kicked'),
    false,
    'kicked 不能出现在终态原因里，否则界面会提示重新扫码',
  )
})

test('认不出的报文不改变状态', () => {
  assert.equal(onFrameRoot(null), null)
  assert.equal(onFrameRoot('text'), null)
  assert.equal(onFrameRoot({ type: 'auth_ack' }), null)
})

test('socket open 是"连接中"，不是"已连接"', () => {
  assert.equal(onSocketEvent({ kind: 'open' }), LED_LOADING)
})

test('只有"真的要重新配对"才把灯变红，其余交给自动重连', () => {
  // 旧行为是九种原因一律变红，于是"另一个客户端占着设备"和"电脑端页面关了"
  // 都被显示成「配对已失效」——用户会立刻反驳"我的链接没改"。现在按类分开。
  for (const reason of ['session-not-found', 'session-expired', 'invalid-mobile-connection']) {
    assert.equal(onSocketEvent({ kind: 'closed', reason: `x ${reason} y` }), LED_ERROR, reason)
  }
  for (const reason of ['desktop-disconnected', 'workspace-closed', 'kicked', 'session-conflict', 'connection-recovery-timeout', 'desktop-bootstrap-timeout']) {
    assert.equal(
      onSocketEvent({ kind: 'closed', reason: `x ${reason} y` }),
      LED_LOADING,
      `${reason} 是可恢复的，不该报成配对失效`,
    )
  }
  assert.equal(onSocketEvent({ kind: 'closed', reason: 'network hiccup' }), LED_LOADING)
  assert.equal(onSocketEvent({ kind: 'closed' }), LED_LOADING)
  assert.equal(isTerminalReason(''), false)
})

test('只有主文档的 4xx/5xx 才算连接异常', () => {
  assert.equal(pageFailureIsConnectionError({ isMainFrame: true, statusCode: 404 }), true)
  assert.equal(pageFailureIsConnectionError({ isMainFrame: true, statusCode: 200 }), false)
  assert.equal(pageFailureIsConnectionError({ isMainFrame: false, statusCode: 500 }), false)
  assert.equal(
    pageFailureIsConnectionError({ isMainFrame: true, statusCode: null }),
    false,
    '拿不到状态码时宁可少报一次异常',
  )
})
