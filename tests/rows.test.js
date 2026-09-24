import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapRow, summarize, toTimeline } from '../client/core/rows.js'

/**
 * 这一组用的是官方 OSS 里 `conversationRowSchema` 的真实形状
 * （`packages/shared/src/zcode-protocol-v4/rows.ts`）：公共字段是
 * `{rowId, turnId, entityId?, createdAt, createdAtSeq}`，按 `kind` 判别，共 9 种。
 * 字段名写错就会渲染成空白——这正是"连上了但看不到会话内容"最容易的成因之一。
 */

const base = (kind, extra) => ({
  rowId: 1,
  turnId: 'turn_1',
  createdAt: 1788000000000,
  createdAtSeq: 1,
  kind,
  ...extra,
})

test('用户输入行', () => {
  const item = mapRow(base('userInput', { text: '帮我看看这个 bug', origin: 'realUser' }))
  assert.equal(item.kind, 'user')
  assert.equal(item.text, '帮我看看这个 bug')
  assert.equal(item.at, 1788000000000)
})

test('助手正文行带模型与状态', () => {
  const item = mapRow(base('assistantText', { text: '好的', state: 'complete', model: 'glm-4.6' }))
  assert.equal(item.kind, 'text')
  assert.equal(item.text, '好的')
  assert.equal(item.meta, 'glm-4.6')
  assert.equal(item.detail, 'complete')
})

test('思考行显示时长', () => {
  const item = mapRow(base('reasoning', { text: '先看调用链', state: 'complete', durationMs: 12500 }))
  assert.equal(item.kind, 'think')
  assert.equal(item.meta, '13s')
})

test('工具行按名字分成终端 / 编辑 / 普通工具', () => {
  assert.equal(mapRow(base('toolCall', { toolName: 'bash', status: 'success', inputText: 'ls' })).kind, 'terminal')
  assert.equal(mapRow(base('toolCall', { toolName: 'str_replace_editor', status: 'success' })).kind, 'edit')
  assert.equal(mapRow(base('toolCall', { toolName: 'web_search', status: 'success' })).kind, 'tool')
})

test('工具行正文优先真实输出，其次命令，其次入参', () => {
  const withPreview = mapRow(
    base('toolCall', { toolName: 'bash', status: 'success', outputPreview: { text: 'file1\nfile2' }, inputText: 'ls' }),
  )
  assert.equal(withPreview.text, 'file1\nfile2')

  const withInput = mapRow(base('toolCall', { toolName: 'bash', status: 'running', inputText: 'npm test' }))
  assert.equal(withInput.text, 'npm test')

  const withInputObject = mapRow(base('toolCall', { toolName: 'bash', status: 'running', input: { cmd: 'ls' } }))
  assert.match(withInputObject.text, /cmd/)
})

test('工具行失败时把错误信息带出来', () => {
  const item = mapRow(
    base('toolCall', {
      toolName: 'bash',
      status: 'error',
      error: { code: 'EACCES', message: 'permission denied' },
    }),
  )
  assert.equal(item.meta, 'error')
  assert.equal(item.detail, 'permission denied')
})

test('一轮的分隔行显示状态与耗时', () => {
  const item = mapRow(
    base('turnHeader', {
      origin: 'userInput',
      state: 'completedSuccess',
      startedAt: 1000,
      endedAt: 61000,
    }),
  )
  assert.equal(item.kind, 'turn')
  assert.equal(item.title, '完成')
  assert.equal(item.meta, '1m')
})

test('产物行显示名称与体积', () => {
  const item = mapRow(
    base('artifact', {
      artifactVersionId: 'v1',
      logicalArtifactKey: 'a',
      displayName: 'report.md',
      artifactType: 'file',
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      ref: 'r',
      state: 'current',
    }),
  )
  assert.equal(item.kind, 'artifact')
  assert.equal(item.title, 'report.md')
  assert.match(item.meta, /file/)
  assert.match(item.meta, /2\.0KB/)
})

test('子智能体行', () => {
  const item = mapRow(base('subagent', { subagentType: 'explore', status: 'running', summaryText: '在读代码' }))
  assert.equal(item.kind, 'subagent')
  assert.equal(item.title, 'explore')
  assert.equal(item.text, '在读代码')
})

test('认不出的 kind 原样展示 JSON，而不是静默吞掉', () => {
  const item = mapRow(base('brandNewRowKind', { payload: { a: 1 } }))
  assert.equal(item.kind, 'unknown')
  assert.match(item.text, /brandNewRowKind|payload/)
})

test('rowsRange 的返回形状是 {rows, atSeq, atRevision, atLogEpoch, hasMore}', () => {
  const items = toTimeline({
    rows: [
      base('userInput', { text: 'hi', rowId: 1 }),
      base('assistantText', { text: 'hello', rowId: 2, state: 'complete' }),
    ],
    atSeq: 9,
    atRevision: 3,
    atLogEpoch: 'e1',
    hasMore: false,
  })
  assert.deepEqual(items.map((item) => item.kind), ['user', 'text'])
  assert.deepEqual(items.map((item) => item.id), ['1', '2'])
})

test('也接受裸数组，且不改动顺序（协议保证 rowId 升序）', () => {
  const rows = [base('userInput', { rowId: 5, text: 'a' }), base('userInput', { rowId: 4, text: 'b' })]
  assert.deepEqual(toTimeline(rows).map((item) => item.text), ['a', 'b'])
})

test('空输入不炸', () => {
  assert.deepEqual(toTimeline(null), [])
  assert.deepEqual(toTimeline({}), [])
  assert.deepEqual(toTimeline({ rows: [null, 'x', 3] }), [])
})

test('汇总统计编辑与涉及文件', () => {
  const items = toTimeline({
    rows: [
      base('toolCall', { toolName: 'str_replace_editor', status: 'success' }),
      base('toolCall', { toolName: 'str_replace_editor', status: 'success' }),
      base('artifact', {
        artifactVersionId: 'v',
        logicalArtifactKey: 'k',
        displayName: 'src/app.ts',
        artifactType: 'file',
        mimeType: 'text/plain',
        sizeBytes: 1,
        sha256: 'b'.repeat(64),
        ref: 'r',
        state: 'current',
      }),
    ],
  })
  const summary = summarize(items)
  assert.equal(summary.edits, 2)
  assert.deepEqual(summary.files, ['src/app.ts'])
})
