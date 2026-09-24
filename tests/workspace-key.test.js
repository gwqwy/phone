import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlatTasks, parseSessionDeltas, parseTaskDeltas } from '../client/core/topics.js'
import { mergeSession } from '../client/core/session-index.js'

/**
 * 这组测试守的是一个具体的线上故障：桥接打开时用工作区的 basename（`demo`）而不是
 * 完整键（`W:\ws\demo`），桌面端不会回 workspace-bridge-ready，症状是"连上了但
 * 看不到会话内容"。所以完整键必须一路带到底，不能被 basename 顶掉。
 */

test('扁平任务视图保留完整工作区路径，另给一份 basename 用于显示', () => {
  const [task] = parseFlatTasks({
    tasks: [{ taskId: 't1', workspacePath: 'W:\\ws\\demo', workspaceLabel: 'demo' }],
  })
  assert.equal(task.workspaceKey, 'W:\\ws\\demo', '桥接要用完整键')
  assert.equal(task.workspace, 'demo', '界面显示用 basename')
})

test('workspaceLabel 缺失时用路径的 basename 兜底显示', () => {
  const [task] = parseFlatTasks({ tasks: [{ taskId: 't1', workspacePath: '/home/me/proj' }] })
  assert.equal(task.workspace, 'proj')
  assert.equal(task.workspaceKey, '/home/me/proj')
})

test('嵌套任务视图的完整键来自 address.workspacePath', () => {
  const { upserts } = parseTaskDeltas({
    deltas: [
      {
        op: 'task.upserted',
        task: {
          address: { taskId: 's1', workspacePath: 'W:\\ws\\demo' },
          meta: { title: 'T' },
        },
      },
    ],
  })
  assert.equal(upserts[0].workspaceKey, 'W:\\ws\\demo')
})

test('meta 里只有 workspacePath 时也能取到完整键', () => {
  const { upserts } = parseTaskDeltas({
    deltas: [{ op: 'task.upserted', task: { address: { taskId: 's1' }, meta: { workspacePath: '/a/b' } } }],
  })
  assert.equal(upserts[0].workspaceKey, '/a/b')
})

test('会话索引的完整键来自主题路径', () => {
  const { upserts } = parseSessionDeltas(
    { deltas: [{ op: 'session.upserted', session: { sessionId: 's1', phase: 'running' } }] },
    'sessions-index/W:\\ws\\demo',
  )
  assert.equal(upserts[0].workspaceKey, 'W:\\ws\\demo', '主题里带的就是完整键')
  assert.equal(upserts[0].workspace, 'demo', '显示仍然用 basename')
})

test('合并时任务侧带键优先，任务侧缺席则由会话侧补上', () => {
  const fromTask = mergeSession({ sessionId: 's', workspaceKey: 'W:\\ws\\demo' }, { sessionId: 's' })
  assert.equal(fromTask.workspaceKey, 'W:\\ws\\demo')

  const fromSession = mergeSession({ sessionId: 's' }, { sessionId: 's', workspaceKey: '/x/y' })
  assert.equal(fromSession.workspaceKey, '/x/y')

  const neither = mergeSession({ sessionId: 's' }, { sessionId: 's' })
  assert.equal(neither.workspaceKey, '')
})
