import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspaces, workspaceKeyFor } from '../client/core/topics.js'
import { RelaySession } from '../client/api/relay-client.js'
import { parsePairingLink } from '../client/core/pairing-link.js'

/**
 * 这组测试来自一次真机故障：电脑端回过
 * 「远程 workspace 不在当前窗口中，无法重连」，而我的代码没看 `success` 字段、
 * 把它记成了 ok，用户因此完全看不到症结。
 *
 * 同时还暴露了 `workspace-list` 回复里有一个独立的 `workspaces` 数组（8 条），
 * 和 `tasks`（11 条）不是一回事——重连要的键大概率出自前者。
 */

test('解析权威工作区数组，容忍字段名差异', () => {
  const list = parseWorkspaces({
    workspaces: [
      { workspaceKey: 'E:\\proj\\a', workspaceLabel: 'a', workspaceKind: 'local' },
      { key: 'E:\\proj\\b', name: 'b' },
      { workspacePath: 'E:\\proj\\c' },
      { path: '/home/me/d' },
      'E:\\proj\\e',
      { nothing: true },
    ],
  })
  assert.deepEqual(
    list.map((item) => item.key),
    ['E:\\proj\\a', 'E:\\proj\\b', 'E:\\proj\\c', '/home/me/d', 'E:\\proj\\e'],
  )
  assert.equal(list[0].label, 'a')
  assert.equal(list[1].label, 'b')
  assert.equal(list[2].label, 'c', '没给标签就用路径尾段')
  assert.equal(list[0].kind, 'local')
})

test('也接受裸数组', () => {
  assert.deepEqual(parseWorkspaces([{ key: 'x' }]).map((item) => item.key), ['x'])
  assert.deepEqual(parseWorkspaces(null), [])
  assert.deepEqual(parseWorkspaces({}), [])
})

test('用任务里的路径或标签去权威列表里换回正确的键', () => {
  const workspaces = parseWorkspaces({
    workspaces: [
      { workspaceKey: 'E:\\proj\\a', workspaceLabel: 'a' },
      { workspaceKey: 'E:\\proj\\b', workspaceLabel: 'b' },
    ],
  })
  assert.equal(workspaceKeyFor(workspaces, { workspaceKey: 'E:\\proj\\b' }), 'E:\\proj\\b')
  assert.equal(workspaceKeyFor(workspaces, { workspace: 'b' }), 'E:\\proj\\b')
  // Windows 上大小写与尾部分隔符不该让用户付出代价
  assert.equal(workspaceKeyFor(workspaces, { workspaceKey: 'e:\\proj\\a\\' }), 'E:\\proj\\a')
})

test('权威列表里找不到时返回空串，让调用方退回任务里的路径', () => {
  assert.equal(workspaceKeyFor([], { workspaceKey: 'x' }), '')
  assert.equal(workspaceKeyFor(parseWorkspaces({ workspaces: [{ key: 'a' }] }), { workspaceKey: 'zzz' }), '')
})

// ---------------------------------------------------------------------------
// 拒绝路径：必须如实报告，而不是当成成功
// ---------------------------------------------------------------------------

function fakeSocket() {
  const sent = []
  const handlers = {}
  return {
    sent,
    send: (text) => sent.push(JSON.parse(text)),
    close: () => handlers.close?.({ code: 1000, reason: '' }),
    onOpen: (fn) => (handlers.open = fn),
    onMessage: (fn) => (handlers.message = fn),
    onError: (fn) => (handlers.error = fn),
    onClose: (fn) => (handlers.close = fn),
    open: () => handlers.open?.({}),
    deliver: (obj) => handlers.message?.(JSON.stringify(obj)),
  }
}

function makeSession(handlers = {}) {
  const socket = fakeSocket()
  const endpoint = parsePairingLink('https://zcode.z.ai/remote/v4?sid=s1&hash=h1', { id: 'e1' })
  const session = new RelaySession({ endpoint, connect: () => socket, handlers })
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })
  return { socket, session }
}

test('bridge-open 无回应时重发有限次，然后如实上报失败', () => {
  const failed = []
  const { socket, session } = makeSession({ onBridgeFailed: (reason) => failed.push(reason) })
  session.openWorkspaceBridge('E:\\proj\\a', 'sess_1')

  // 电脑端对 bridge-open 完全没有回应（真机就是这样）。手动推进重发定时器。
  const before = session.bridgeAttempts
  assert.equal(before, 1)
  for (let i = 0; i < 2; i++) {
    session.lastBridgeOpenAt = 0
    session.sendBridgeOpen()
  }
  assert.equal(session.bridgeAttempts, 3)
  assert.equal(
    socket.sent.filter((message) => message.payload?.zcode_type === 'workspace-bridge-open').length,
    3,
    '总共发三次就该停手，不能无限重发',
  )
  assert.equal(failed.length, 1, '放弃时必须如实告诉上层，否则界面只能一直转圈')
  assert.ok(
    session.log.some((entry) => entry.direction === '!' && entry.text.includes('没有回应')),
    '诊断日志里要留下这条结论',
  )
  session.stop()
})

test('bridge-ready 之后就绪，重发立刻停止', () => {
  const { socket, session } = makeSession()
  session.openWorkspaceBridge('E:\\proj\\a', 'sess_1')
  socket.deliver({
    type: 'data',
    payload: {
      zcode_type: 'workspace-bridge-ready',
      bridge: { bridgeSessionId: 'b1', bridgeGeneration: 0, recoveryId: 'r1', workspaceKey: 'E:\\proj\\a' },
    },
  })
  assert.equal(session.bridgeReady, true)
  assert.ok(session.channel, '通道必须就绪')
  session.lastBridgeOpenAt = 0
  session.sendBridgeOpen()
  session.stop()
  assert.equal(
    socket.sent.filter((message) => message.payload?.zcode_type === 'workspace-bridge-open').length,
    1,
    '就绪后不该再发',
  )
})
