import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LED_ERROR,
  LED_LIVE,
  LED_LOADING,
  TERMINAL_REASONS,
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

test('终态判定用官方关闭码，不能把通用断开当成"配对失效"', () => {
  // 真机症状：电脑端连接一直没变，手机却偶发显示「配对已失效」。
  // 根因是拿关闭原因字符串当错误码去比，任何一次普通断开都落进"未知错误码"分支被判成终态。
  assert.equal(isTerminalClose(4004, ''), true, 'SessionNotFound')
  assert.equal(isTerminalClose(4011, ''), true, 'SessionExpired')
  assert.equal(isTerminalClose(4013, ''), true, 'InvalidMobileConnection')

  assert.equal(isTerminalClose(1006, ''), false, '异常关闭只是网络断了')
  assert.equal(isTerminalClose(1005, ''), false, '没有状态码')
  assert.equal(isTerminalClose(1000, ''), false, '正常关闭')
  assert.equal(isTerminalClose(0, ''), false, '拿不到码时默认不算终态')

  // 拿不到码时才退回文本匹配
  assert.equal(isTerminalClose(0, 'desktop-disconnected'), true)
  assert.equal(isTerminalClose(1006, 'session-expired'), true, '文本里有明确原因就认')

  // 这一条是回归测试：曾经 reason 为空串都会判成终态
  assert.equal(isTerminalClose(undefined, undefined), false)
  assert.equal(isTerminalClose(undefined, 'whatever'), false)
})

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

test('终态关闭原因把灯变红，普通断开继续显示连接中', () => {
  for (const reason of TERMINAL_REASONS) {
    assert.equal(onSocketEvent({ kind: 'closed', reason: `x ${reason} y` }), LED_ERROR, reason)
    assert.equal(isTerminalReason(reason), true)
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
