import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NOTIFY_PREFS,
  StateDiffer,
  notificationSlot,
  retractableSlots,
  shouldNotify,
} from '../client/core/event-differ.js'

test('待办计数 0→>0 才通知', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 0 }])
  const events = differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 1 }])
  assert.deepEqual(events.map((e) => e.type), ['permission_request'])
})

test('需要输入走另一类事件', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', userInputCount: 0 }])
  const events = differ.apply([{ sessionId: 's', phase: 'running', userInputCount: 2 }])
  assert.deepEqual(events.map((e) => e.type), ['elicitation_request'])
})

test('计数减少但没归零：既不通知也不撤回', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 2 }])
  const events = differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 1 }])
  assert.deepEqual(events, [], '用户还在处理中，不该再打扰也不该撤回')
})

test('计数归零才撤回', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 2 }])
  assert.deepEqual(differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 1 }]), [])
  const events = differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 0 }])
  assert.deepEqual(events.map((e) => e.type), ['resolved'])
})

test('首次见到就带着待办也要通知（这不是历史记录，是此刻在等你）', () => {
  const differ = new StateDiffer()
  const events = differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 3 }])
  assert.deepEqual(events.map((e) => e.type), ['permission_request'])
})

test('首次见到就是终态：只登记，不通知', () => {
  const differ = new StateDiffer()
  const events = differ.apply([{ sessionId: 's', phase: 'completedSuccess' }])
  assert.deepEqual(events, [], '刚打开 App 就被历史完成记录刷屏是最经典的体验事故')
  // 但这之后的状态变化仍然照常通知
  assert.deepEqual(differ.apply([{ sessionId: 's', phase: 'running' }]), [])
  assert.deepEqual(differ.apply([{ sessionId: 's', phase: 'completedSuccess' }]).map((e) => e.type), [
    'completed',
  ])
})

test('阶段进入失败 / 完成时通知，重复终态不重复通知', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running' }])
  assert.deepEqual(differ.apply([{ sessionId: 's', phase: 'error' }]).map((e) => e.type), ['error'])
  assert.deepEqual(differ.apply([{ sessionId: 's', phase: 'error' }]), [], '同态不重复通知')
})

test('空帧不能抹掉上一次的状态', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 0 }])
  assert.deepEqual(differ.apply([]), [])
  assert.deepEqual(differ.apply(null), [])
  const events = differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 1 }])
  assert.deepEqual(events.map((e) => e.type), ['permission_request'], '上一帧若把状态抹掉，这里就会被误判成 0→>0')
})

test('会话被显式移除且当时有待办：产生撤回', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running', permissionCount: 1 }])
  assert.deepEqual(differ.remove('s').map((e) => e.type), ['resolved'])
  assert.deepEqual(differ.remove('s'), [], '重复移除无效')
})

test('移除一个没有待办的会话不产生任何事件', () => {
  const differ = new StateDiffer()
  differ.apply([{ sessionId: 's', phase: 'running' }])
  assert.deepEqual(differ.remove('s'), [])
  assert.deepEqual(differ.remove('unknown'), [])
})

test('通知偏好：默认只开审批', () => {
  assert.deepEqual(DEFAULT_NOTIFY_PREFS, { approval: true, complete: false, fail: false })
  assert.equal(shouldNotify('permission_request'), true)
  assert.equal(shouldNotify('elicitation_request'), true)
  assert.equal(shouldNotify('completed'), false)
  assert.equal(shouldNotify('error'), false)
  assert.equal(shouldNotify('resolved'), false, '撤回信号自己不该发通知')
  assert.equal(shouldNotify('completed', { complete: true }), true)
})

test('通知槽位键：同端点同类型同会话共用一个槽位', () => {
  assert.equal(notificationSlot('e1', 'permission_request', 's1'), 'shou|e1|permission_request|s1')
  assert.deepEqual(retractableSlots('e1', 's1'), [
    'shou|e1|permission_request|s1',
    'shou|e1|elicitation_request|s1',
  ])
})
