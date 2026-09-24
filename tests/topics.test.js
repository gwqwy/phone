import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64 } from '../client/core/crypto.js'
import { utf8Bytes } from '../client/core/rpc-wire.js'
import {
  FragmentAssembler,
  findEnvelope,
  findTopicFrame,
  isBootstrapResult,
  isKnownEventName,
  parseFlatTasks,
  parseFrameText,
  parseSessionDeltas,
  parseTaskDeltas,
} from '../client/core/topics.js'

test('帧文本解析：接受裸 JSON 与带前缀的 JSON，拒绝 SSE 与 HTML', () => {
  assert.deepEqual(parseFrameText('{"a":1}'), { a: 1 })
  assert.deepEqual(parseFrameText('data: {"a":1}'), { a: 1 })
  assert.deepEqual(parseFrameText('  {"a":1} trailing  '), { a: 1 })
  assert.equal(parseFrameText('<!doctype html><html></html>'), null)
  assert.equal(parseFrameText('not json'), null)
  assert.equal(parseFrameText(''), null)
  assert.equal(parseFrameText(undefined), null)
})

test('bootstrap 前缀决定"整表替换"语义', () => {
  assert.equal(isBootstrapResult('bootstrap-abc'), true)
  assert.equal(isBootstrapResult('workspace-list-abc'), false)
  assert.equal(isBootstrapResult(''), false)
})

test('事件白名单：认不出的名字一律忽略', () => {
  for (const name of ['created', 'streaming', 'permission_request', 'completed', 'error']) {
    assert.equal(isKnownEventName(name), true)
  }
  assert.equal(isKnownEventName('brand_new_thing'), false)
})

test('会话 delta：upsert 与 remove，含嵌套在 frame.payload 里的形态', () => {
  const frame = {
    topic: 'sessions-index/W:\\ws\\demo',
    frame: {
      topic: 'sessions-index/W:\\ws\\demo',
      payload: {
        kind: 'deltas',
        deltas: [
          {
            op: 'session.upserted',
            session: {
              sessionId: 'sess_b',
              title: 'hi',
              phase: 'running',
              pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
              pendingInteraction: { kind: 'permission', toolName: 'shell', description: 'rm -rf' },
              lastActivityAt: 1700000000000,
            },
          },
          { op: 'session.removed', sessionId: 'sess_gone' },
        ],
      },
    },
  }
  const { upserts, removes } = parseSessionDeltas(frame.frame.payload, frame.frame.topic)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].sessionId, 'sess_b')
  assert.equal(upserts[0].phase, 'running')
  assert.equal(upserts[0].permissionCount, 1)
  assert.equal(upserts[0].toolName, 'shell')
  assert.equal(upserts[0].description, 'rm -rf')
  assert.equal(upserts[0].workspace, 'demo', 'workspaceId 取 basename')
  assert.deepEqual(removes, ['sess_gone'])
})

test('会话 delta：缺 sessionId 的条目被丢弃', () => {
  const { upserts } = parseSessionDeltas({ deltas: [{ op: 'session.upserted', session: { title: 'x' } }] })
  assert.deepEqual(upserts, [])
})

test('会话快照', () => {
  const { upserts } = parseSessionDeltas({
    kind: 'snapshot',
    snapshot: { sessions: [{ sessionId: 'a', phase: 'running' }] },
  })
  assert.deepEqual(upserts.map((s) => s.sessionId), ['a'])
})

test('任务 delta：置顶、归档、移除、嵌套字段映射', () => {
  const payload = {
    kind: 'deltas',
    deltas: [
      {
        op: 'task.upserted',
        task: {
          address: { workspacePath: 'W:\\ws\\demo', taskId: 'sess_1' },
          meta: { title: 'T1', createdAt: 100, updatedAt: 200, status: 'running', workspacePath: 'W:\\ws\\demo' },
          membership: { pinned: true, archived: false },
          activity: { phase: 'running', lastActivityAt: 300 },
        },
      },
      {
        op: 'task.upserted',
        task: {
          address: { taskId: 'sess_arch' },
          meta: { title: 'archived one', status: 'completed' },
          membership: { archived: true },
        },
      },
      { op: 'task.removed', address: { taskId: 'sess_removed' } },
    ],
  }
  const { upserts, removes, archived } = parseTaskDeltas(payload)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].sessionId, 'sess_1')
  assert.equal(upserts[0].workspace, 'demo')
  assert.equal(upserts[0].pinned, true)
  assert.equal(upserts[0].lastActivityAt, 300)
  assert.deepEqual(archived, ['sess_arch'], '归档不能留在列表里')
  assert.deepEqual(removes, ['sess_removed'])
})

test('任务 delta：缺 activity 时回落到 meta.status', () => {
  const { upserts } = parseTaskDeltas({
    deltas: [{ op: 'task.upserted', task: { address: { taskId: 's' }, meta: { status: 'completed' } } }],
  })
  assert.equal(upserts[0].phase, 'completedSuccess')
})

test('任务快照里是裸任务对象', () => {
  const { upserts } = parseTaskDeltas({
    kind: 'snapshot',
    snapshot: { tasks: [{ address: { taskId: 's1' }, meta: { title: 'A' } }] },
  })
  assert.deepEqual(upserts.map((t) => t.sessionId), ['s1'])
})

test('扁平任务视图：displayStatus 与 workspaceLabel', () => {
  const tasks = parseFlatTasks({
    tasks: [
      { taskId: 'a', title: 'A', displayStatus: 'running', updatedAt: 5, workspaceLabel: 'demo' },
      { taskId: 'b', displayStatus: 'error', workspacePath: 'W:\\ws\\two' },
      { title: 'no id' },
    ],
  })
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].phase, 'running')
  assert.equal(tasks[1].phase, 'error')
  assert.equal(tasks[1].workspace, 'two')
  assert.deepEqual(parseFlatTasks([{ taskId: 'c' }]).map((t) => t.sessionId), ['c'], '也接受裸数组')
})

test('从任意嵌套里找出信封与 topic 帧', () => {
  const envelope = findEnvelope({ type: 'data', payload: { zcode_type: 'bootstrap-response', result: {} } })
  assert.equal(envelope.zcode_type, 'bootstrap-response')
  const topic = { frame: { topic: 'controller/tasks-index', payload: { deltas: [] } } }
  assert.equal(findTopicFrame({ a: { b: topic } }).topic, 'controller/tasks-index')
  assert.equal(findEnvelope({ nothing: true }), null)
})

test('分片重组：按序拼齐后解出 JSON，缺片不产出', () => {
  const assembler = new FragmentAssembler()
  const text = '{"hello":"world"}'
  const bytes = utf8Bytes(text)
  const half = Math.ceil(bytes.length / 2)
  const first = base64(bytes.subarray(0, half))
  const second = base64(bytes.subarray(half))

  assert.equal(
    assembler.accept({ logicalFrameId: 'f1', fragmentIndex: 0, fragmentCount: 2, dataBase64: first }),
    null,
  )
  const assembled = assembler.accept({
    logicalFrameId: 'f1',
    fragmentIndex: 1,
    fragmentCount: 2,
    dataBase64: second,
  })
  assert.equal(assembled, text)
})

test('分片重组：重复分片不重复计数', () => {
  const assembler = new FragmentAssembler()
  const bytes = utf8Bytes('abcd')
  const first = base64(bytes.subarray(0, 2))
  const second = base64(bytes.subarray(2))
  assembler.accept({ logicalFrameId: 'f2', fragmentIndex: 0, fragmentCount: 2, dataBase64: first })
  assembler.accept({ logicalFrameId: 'f2', fragmentIndex: 0, fragmentCount: 2, dataBase64: first })
  const assembled = assembler.accept({
    logicalFrameId: 'f2',
    fragmentIndex: 1,
    fragmentCount: 2,
    dataBase64: second,
  })
  assert.equal(assembled, 'abcd')
})

test('分片重组：多字节字符跨片也能还原', () => {
  const assembler = new FragmentAssembler()
  const bytes = utf8Bytes('中文测试')
  const cut = 5
  assert.equal(
    assembler.accept({
      logicalFrameId: 'f3',
      fragmentIndex: 0,
      fragmentCount: 2,
      dataBase64: base64(bytes.subarray(0, cut)),
    }),
    null,
  )
  assert.equal(
    assembler.accept({
      logicalFrameId: 'f3',
      fragmentIndex: 1,
      fragmentCount: 2,
      dataBase64: base64(bytes.subarray(cut)),
    }),
    '中文测试',
  )
})
