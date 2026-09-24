import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionIndex,
  basename,
  calendarDayDiff,
  compareSessions,
  formatRelative,
  groupByDay,
  groupLabel,
  mergeSession,
  phaseFromStatus,
  sortSessions,
  taskFromFlat,
  taskFromNested,
} from '../client/core/session-index.js'

const at = (iso) => new Date(iso).getTime()

test('合并时按字段划分权威来源', () => {
  const merged = mergeSession(
    { sessionId: 's1', title: '任务标题', workspace: 'demo', pinned: true, phase: 'completedSuccess' },
    { sessionId: 's1', phase: 'running', lastActivityAt: 500, permissionCount: 2, toolName: 'shell' },
  )
  assert.equal(merged.title, '任务标题', '标题归任务索引')
  assert.equal(merged.workspace, 'demo', '工作区归任务索引')
  assert.equal(merged.pinned, true, '置顶归任务索引')
  assert.equal(merged.phase, 'running', '阶段归会话索引')
  assert.equal(merged.lastActivityAt, 500)
  assert.equal(merged.permissionCount, 2)
  assert.equal(merged.toolName, 'shell')
})

test('会话索引的时间戳为 null 时不覆盖任务索引的值', () => {
  const merged = mergeSession(
    { sessionId: 's1', lastActivityAt: 100, createdAt: 50 },
    { sessionId: 's1', lastActivityAt: null, createdAt: null },
  )
  assert.equal(merged.lastActivityAt, 100)
  assert.equal(merged.createdAt, 50)
})

test('排序：运行中优先，运行中按创建时间倒序，其余按最近活动倒序', () => {
  const list = [
    { sessionId: 'done-old', phase: 'completedSuccess', lastActivityAt: 10, createdAt: 1 },
    { sessionId: 'run-new', phase: 'running', createdAt: 200 },
    { sessionId: 'run-old', phase: 'running', createdAt: 100 },
    { sessionId: 'done-new', phase: 'completedSuccess', lastActivityAt: 900, createdAt: 2 },
    { sessionId: 'no-time', phase: 'completedSuccess', lastActivityAt: null, createdAt: null },
  ]
  assert.deepEqual(
    sortSessions(list).map((s) => s.sessionId),
    ['run-new', 'run-old', 'done-new', 'done-old', 'no-time'],
    '没有时间戳的排最后，不能挤到最前面',
  )
})

test('待办计数不参与排序（否则列表会在处理审批时跳动）', () => {
  const a = { sessionId: 'a', phase: 'completedSuccess', lastActivityAt: 900, permissionCount: 5 }
  const b = { sessionId: 'b', phase: 'completedSuccess', lastActivityAt: 100, permissionCount: 0 }
  assert.equal(compareSessions(a, b) < 0, true, '最近活动的在前，尽管它的待办更多')
})

test('相同比较键时用 sessionId 兜底，保证顺序稳定', () => {
  const list = [
    { sessionId: 'b', phase: 'running', createdAt: 5 },
    { sessionId: 'a', phase: 'running', createdAt: 5 },
  ]
  assert.deepEqual(sortSessions(list).map((s) => s.sessionId), ['a', 'b'])
})

test('相对时间分档，未来时间显示"刚刚"', () => {
  const now = at('2026-09-23T12:00:00')
  assert.equal(formatRelative(now - 1000, now, 'zh'), '刚刚')
  assert.equal(formatRelative(now + 60000, now, 'zh'), '刚刚', '时钟不同步时不能显示负数')
  assert.equal(formatRelative(now - 120000, now, 'zh'), '2分钟')
  assert.equal(formatRelative(now - 3600000 * 3, now, 'zh'), '3小时')
  assert.equal(formatRelative(now - 86400000 * 4, now, 'zh'), '4天')
  assert.equal(formatRelative(null, now, 'zh'), '')
  assert.equal(formatRelative(now - 120000, now, 'en'), '2m')
})

test('按本地日历日算差，而不是按 24 小时', () => {
  assert.equal(calendarDayDiff(at('2026-09-23T23:50:00'), at('2026-09-24T00:10:00')), 1)
  assert.equal(calendarDayDiff(at('2026-09-23T00:10:00'), at('2026-09-23T23:50:00')), 0)
})

test('分组：置顶最前，其余按日桶，未知时间排最后', () => {
  const now = at('2026-09-23T12:00:00')
  const list = [
    { sessionId: 'p', pinned: true, lastActivityAt: at('2020-01-01T00:00:00') },
    { sessionId: 't', lastActivityAt: at('2026-09-23T09:00:00') },
    { sessionId: 'y', lastActivityAt: at('2026-09-22T09:00:00') },
    { sessionId: 'd2', lastActivityAt: at('2026-09-21T09:00:00') },
    { sessionId: 'd3', lastActivityAt: at('2026-09-20T09:00:00') },
    { sessionId: 'old', lastActivityAt: at('2026-01-01T09:00:00') },
    { sessionId: 'u', lastActivityAt: null },
  ]
  const keys = groupByDay(list, { now, lang: 'zh' }).map((g) => g.key)
  assert.deepEqual(keys.slice(0, 4), ['pinned', 'today', 'yesterday', 'day:2'], '置顶必须最前')
  assert.ok(keys.includes('day:3'))
  assert.equal(keys[keys.length - 1], 'unknown', '未知时间必须排最后')
  assert.equal(keys[0], 'pinned', '即使置顶那条是 2020 年的也要在最前')
})

test('置顶不会同时出现在日桶里', () => {
  const now = at('2026-09-23T12:00:00')
  const list = [{ sessionId: 'p', pinned: true, lastActivityAt: now }]
  const groups = groupByDay(list, { now })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'pinned')
})

test('分组文案中英双语', () => {
  assert.equal(groupLabel('pinned', 'zh'), '置顶')
  assert.equal(groupLabel('today', 'zh'), '今天')
  assert.equal(groupLabel('day:2', 'zh'), '2 天前')
  assert.equal(groupLabel('older', 'en'), 'Earlier')
})

test('phaseFromStatus 只认三个已知状态', () => {
  assert.equal(phaseFromStatus('completed'), 'completedSuccess')
  assert.equal(phaseFromStatus('error'), 'error')
  assert.equal(phaseFromStatus('running'), 'running')
  assert.equal(phaseFromStatus('weird'), null)
})

test('SessionIndex：任务索引增量不清空置顶', () => {
  const index = new SessionIndex()
  index.upsertTasks([{ sessionId: 's1', title: 'A', pinned: true }])
  index.upsertTasks([{ sessionId: 's1', title: 'A2' }])
  assert.equal(index.get('s1').pinned, true, '任务索引缺席 pinned 时不能把置顶弄丢')
  assert.equal(index.get('s1').title, 'A2')
})

test('SessionIndex：bootstrap 整表替换默认丢置顶，显式保留时留住', () => {
  const make = () => {
    const index = new SessionIndex()
    index.upsertTasks([{ sessionId: 's1', title: 'A', pinned: true }])
    return index
  }
  const plain = make()
  plain.replaceTasks([{ sessionId: 's1', title: 'A', pinned: false }])
  assert.equal(plain.get('s1').pinned, false)

  const keep = make()
  keep.replaceTasks([{ sessionId: 's1', title: 'A' }], { preservePinned: true })
  assert.equal(keep.get('s1').pinned, true)
})

test('SessionIndex：归档表现为移除，且不再回到列表', () => {
  const index = new SessionIndex()
  index.upsertTasks([{ sessionId: 's1', title: 'A' }])
  index.upsertSessions([{ sessionId: 's1', phase: 'running' }])
  assert.equal(index.list().length, 1)

  index.upsertArchived(['s1'])
  assert.equal(index.list().length, 0, '归档的任务不能继续挂在列表里')

  index.upsertTasks([{ sessionId: 's1', title: 'A' }])
  assert.equal(index.list().length, 1, '任务索引再次出现时解除归档状态')
})

test('SessionIndex：两路增量合起来才是完整视图', () => {
  const index = new SessionIndex()
  index.upsertTasks([{ sessionId: 's1', title: '标题', workspace: 'demo', pinned: true }])
  index.upsertSessions([{ sessionId: 's1', phase: 'running', permissionCount: 1 }])
  const one = index.list()[0]
  assert.equal(one.title, '标题')
  assert.equal(one.workspace, 'demo')
  assert.equal(one.pinned, true)
  assert.equal(one.phase, 'running')
  assert.equal(one.permissionCount, 1)
})

test('扁平任务视图映射', () => {
  const task = taskFromFlat({
    taskId: 't1',
    title: '代码审查',
    displayStatus: 'running',
    updatedAt: 123,
    createdAt: 100,
    workspaceLabel: 'demo',
    workspacePath: 'W:\\ws\\demo',
  })
  assert.equal(task.sessionId, 't1')
  assert.equal(task.phase, 'running')
  assert.equal(task.workspace, 'demo', 'workspaceLabel 优先')
  assert.equal(task.lastActivityAt, 123)
  assert.equal(taskFromFlat({}), null)
  assert.equal(taskFromFlat({ taskId: 'x', workspacePath: 'W:\\ws\\other' }).workspace, 'other')
})

test('嵌套任务视图映射，含置顶与归档', () => {
  const task = taskFromNested({
    address: { workspacePath: 'W:\\ws\\demo', taskId: 'sess_1' },
    meta: { title: 'T', createdAt: 1, updatedAt: 2, status: 'running' },
    membership: { pinned: true, archived: false },
    activity: { phase: 'running', lastActivityAt: 3 },
  })
  assert.equal(task.sessionId, 'sess_1')
  assert.equal(task.workspace, 'demo')
  assert.equal(task.pinned, true)
  assert.equal(task.lastActivityAt, 3)
  assert.equal(taskFromNested({ address: {} }), null)
})

test('basename 兼容 Windows 与 POSIX 分隔符', () => {
  assert.equal(basename('W:\\ws\\demo'), 'demo')
  assert.equal(basename('/home/me/demo'), 'demo')
  assert.equal(basename('demo'), 'demo')
  assert.equal(basename(''), '')
})
