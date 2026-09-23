import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapStatus, messageToEvents, rowsToEvents } from '../src/adapters/zcode/map.ts'

test('messageToEvents：用户消息/AI 正文/思考/工具/审批', () => {
  const events = messageToEvents({
    info: { id: 'm1', role: 'user', time: { created: 1790100000000 } },
    parts: [{ id: 'p1', type: 'text', text: '你好', time: { start: 1790100000000 } }],
  })
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, 'user')
  assert.equal(events[0]!.text, '你好')

  const ai = messageToEvents({
    info: { id: 'm2', role: 'assistant', time: { created: 1790100001000 } },
    parts: [
      { id: 'p2', type: 'reasoning', text: '想想', time: { start: 1790100001000, end: 1790100004000 } },
      { id: 'p3', type: 'tool', tool: 'Edit', state: { status: 'completed', input: { file_path: 'E:\\x\\a.ts' }, title: 'a.ts', time: { start: 1790100005000, end: 1790100006000 } } },
      { id: 'p4', type: 'tool', tool: 'Bash', state: { status: 'running', input: { command: 'npm test' }, time: { start: 1790100007000 } } },
      { id: 'p5', type: 'patch', files: ['a.ts', 'b.ts'] },
    ],
  })
  const kinds = ai.map((e) => e.kind)
  assert.deepEqual(kinds, ['think', 'edit', 'terminal', 'patch'])
  assert.equal(ai[0]!.meta?.durationSec, 3)
  assert.equal(ai[1]!.meta?.file, 'E:\\x\\a.ts')
  assert.equal(ai[2]!.status, 'running')
  assert.equal(ai[3]!.meta?.files.length, 2)
})

test('rowsToEvents：v4 投影行 → 统一事件（含审批卡）', () => {
  const events = rowsToEvents([
    { kind: 'turnHeader', rowId: 1, state: 'completedSuccess', createdAt: '2026-09-23T00:00:00Z' },
    { kind: 'userInput', rowId: 2, text: '建个文件', createdAt: '2026-09-23T00:00:01Z' },
    { kind: 'reasoning', rowId: 3, text: '思考中', state: 'complete', durationMs: 3400, createdAt: '2026-09-23T00:00:02Z' },
    { kind: 'toolCall', rowId: 4, toolName: 'Write', status: 'pendingApproval', inputText: '写 a.txt', approvalInteractionId: 'perm_1', createdAt: '2026-09-23T00:00:03Z' },
    { kind: 'assistantText', rowId: 5, text: '完成了', state: 'complete', createdAt: '2026-09-23T00:00:04Z' },
  ])
  const kinds = events.map((e) => e.kind)
  assert.deepEqual(kinds, ['user', 'think', 'approval', 'text'])
  const approval = events.find((e) => e.kind === 'approval')!
  assert.equal(approval.meta?.interactionId, 'perm_1')
  assert.equal(approval.meta?.toolName, 'Write')
  const think = events.find((e) => e.kind === 'think')!
  assert.equal(think.meta?.durationSec, 3.4)
})

test('mapStatus：ZCode 状态 → 统一状态', () => {
  assert.equal(mapStatus('running'), 'running')
  assert.equal(mapStatus('waiting'), 'waiting-approval')
  assert.equal(mapStatus('completed'), 'completed')
  assert.equal(mapStatus('error'), 'error')
  assert.equal(mapStatus('paused'), 'idle')
  assert.equal(mapStatus('mystery'), 'unknown')
})
