/**
 * 会话索引：两路数据合并、排序、分组、相对时间。
 *
 * 一台 ZCode 桌面端会推两种索引，它们的权威范围不同，必须分开记：
 *   - 任务索引（controller/tasks-index）：标题、工作区、置顶/归档归属的权威来源；
 *   - 会话索引（sessions-index）：阶段、最近活动时间、待办计数的权威来源。
 * 合并规则搞反了就会出现"置顶突然消失"或"状态停在运行中"这类问题。
 */

export const PHASE_RUNNING = 'running'
export const PHASE_COMPLETED = 'completedSuccess'
export const PHASE_INTERRUPTED = 'completedInterrupted'
export const PHASE_ERROR = 'error'

const DONE_PHASES = new Set([PHASE_COMPLETED, PHASE_INTERRUPTED])

export function isRunning(phase) {
  return phase === PHASE_RUNNING
}

export function isDone(phase) {
  return DONE_PHASES.has(phase)
}

export function isError(phase) {
  return phase === PHASE_ERROR
}

/** 桌面端 meta.status 到阶段名的映射；认不出就返回 null（界面不显示状态胶囊）。 */
export function phaseFromStatus(status) {
  switch (status) {
    case 'completed':
      return PHASE_COMPLETED
    case 'error':
      return PHASE_ERROR
    case 'running':
      return PHASE_RUNNING
    default:
      return null
  }
}

/**
 * 合并同一个会话的两路数据。
 *
 * 会话侧赢的字段：phase、lastActivityAt（非空时）、createdAt（非空时）、待办计数与交互详情。
 * 任务侧赢的字段：title、workspace、pinned。
 */
export function mergeSession(task, session) {
  const t = task ?? {}
  const s = session ?? {}
  return {
    sessionId: s.sessionId ?? t.sessionId ?? '',
    title: t.title || s.title || '',
    workspace: t.workspace || s.workspace || '',
    // 完整工作区键：打开桥接必须用它（basename 会被桌面端拒绝）。
    workspaceKey: t.workspaceKey || s.workspaceKey || '',
    phase: s.phase ?? t.phase ?? null,
    lastActivityAt: s.lastActivityAt ?? t.lastActivityAt ?? null,
    createdAt: s.createdAt ?? t.createdAt ?? null,
    pinned: Boolean(t.pinned ?? s.pinned),
    permissionCount: s.permissionCount ?? 0,
    userInputCount: s.userInputCount ?? 0,
    interactionKind: s.interactionKind ?? '',
    toolName: s.toolName ?? '',
    description: s.description ?? '',
  }
}

/**
 * 排序：运行中的排最前，其余按最近活动倒序。
 *
 * 注意待办计数**不参与**排序——把"等你审批"的会话顶到最前听起来合理，实际会让列表
 * 在用户处理审批的瞬间跳来跳去，用户会找不到刚才在看的那一条。
 */
export function compareSessions(a, b) {
  const aRun = isRunning(a.phase) ? 0 : 1
  const bRun = isRunning(b.phase) ? 0 : 1
  if (aRun !== bRun) return aRun - bRun

  if (aRun === 0) {
    const byCreated = compareDesc(a.createdAt, b.createdAt)
    if (byCreated !== 0) return byCreated
  } else {
    const byActivity = compareDesc(a.lastActivityAt, b.lastActivityAt)
    if (byActivity !== 0) return byActivity
    const byCreated = compareDesc(a.createdAt, b.createdAt)
    if (byCreated !== 0) return byCreated
  }
  return String(a.sessionId).localeCompare(String(b.sessionId))
}

/** 降序比较：值大的排前；null / 非数字一律视为最小（排最后）。 */
function compareDesc(x, y) {
  const xv = typeof x === 'number' && isFinite(x) ? x : null
  const yv = typeof y === 'number' && isFinite(y) ? y : null
  if (xv === null && yv === null) return 0
  if (xv === null) return 1
  if (yv === null) return -1
  return yv - xv
}

export function sortSessions(list) {
  return list.slice().sort(compareSessions)
}

/**
 * 相对时间。按上游的措辞习惯输出不带「前/ago」后缀的词组：
 * 刚刚 / 12分钟 / 1小时 / 3天。未来时间一律显示「刚刚」——
 * 设备之间时钟不同步时这是唯一不会让用户困惑的选项。
 */
export function formatRelative(timestamp, now = Date.now(), lang = 'zh') {
  const zh = lang !== 'en'
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) return ''
  const diff = now - timestamp
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return zh ? '刚刚' : 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return zh ? `${min}分钟` : `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return zh ? `${hour}小时` : `${hour}h`
  const day = Math.floor(hour / 24)
  return zh ? `${day}天` : `${day}d`
}

/** 本地日历日之差（不是 24 小时差）：23:50 与次日 00:10 必须算作两天。 */
export function calendarDayDiff(from, to) {
  const a = new Date(from)
  const b = new Date(to)
  const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((dayB - dayA) / 86400000)
}

/** 一周边界：中文习惯周一，英文习惯周日。 */
function weekStartDay(lang) {
  return lang === 'en' ? 0 : 1
}

/**
 * 分组。置顶单独成组排最前，其余按时间落入具名桶。
 * 桶的键是稳定的：界面用键做可折叠分组的记忆，所以键不能随当前时间变形。
 */
export function groupByDay(list, { lang = 'zh', now = Date.now() } = {}) {
  const groups = new Map()
  const ordered = []
  const push = (key, item) => {
    if (!groups.has(key)) {
      groups.set(key, [])
      ordered.push(key)
    }
    groups.get(key).push(item)
  }

  for (const item of list) {
    if (item.pinned) push('pinned', item)
  }
  for (const item of list) {
    if (item.pinned) continue
    push(bucketOf(item, lang, now), item)
  }
  return ordered.map((key) => ({ key, items: groups.get(key) }))
}

function bucketOf(item, lang, now) {
  const ts = item.lastActivityAt ?? item.createdAt
  if (typeof ts !== 'number' || !isFinite(ts)) return 'unknown'

  const diff = calendarDayDiff(ts, now)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff <= 3) return `day:${diff}`
  if (diff < 7) return 'thisWeek'
  if (diff < 14) return 'lastWeek'
  if (diff < 31) return 'thisMonth'
  if (diff < 62) return 'lastMonth'
  return 'older'
}

/** 分组键的显示文案。 */
export function groupLabel(key, lang = 'zh') {
  const zh = lang !== 'en'
  if (key === 'pinned') return zh ? '置顶' : 'Pinned'
  if (key === 'today') return zh ? '今天' : 'Today'
  if (key === 'yesterday') return zh ? '昨天' : 'Yesterday'
  if (key === 'unknown') return zh ? '时间未知' : 'Unknown time'
  if (key.startsWith('day:')) {
    const n = Number(key.slice(4))
    return zh ? `${n} 天前` : `${n} days ago`
  }
  if (key === 'thisWeek') return zh ? '本周' : 'This week'
  if (key === 'lastWeek') return zh ? '上周' : 'Last week'
  if (key === 'thisMonth') return zh ? '本月' : 'This month'
  if (key === 'lastMonth') return zh ? '上个月' : 'Last month'
  if (key === 'older') return zh ? '更早' : 'Earlier'
  return key
}

/**
 * 订单簿式索引器：按 sessionId 维护一份合并后的会话表。
 *
 *   - upsertTasks：任务索引的增量，**不清空** pinned（任务索引缺席时不能把置顶弄丢）；
 *   - replaceTasks：bootstrap 用的整表替换，`preservePinned` 让既有置顶活下来；
 *   - upsertSessions / removeSessions：会话索引的增量与移除；
 *   - upsertArchived：归档在任务索引里表现为移除信号。
 */
export class SessionIndex {
  constructor() {
    this.tasks = new Map()
    this.sessions = new Map()
    this.archived = new Set()
  }

  list() {
    const ids = new Set([...this.tasks.keys(), ...this.sessions.keys()])
    const out = []
    for (const id of ids) {
      if (this.archived.has(id)) continue
      out.push(mergeSession(this.tasks.get(id), this.sessions.get(id)))
    }
    return sortSessions(out)
  }

  get(sessionId) {
    return mergeSession(this.tasks.get(sessionId), this.sessions.get(sessionId))
  }

  upsertTasks(tasks) {
    for (const task of tasks) {
      if (!task?.sessionId) continue
      this.tasks.set(task.sessionId, { ...(this.tasks.get(task.sessionId) ?? {}), ...task })
      this.archived.delete(task.sessionId)
    }
    return this
  }

  replaceTasks(tasks, { preservePinned = false } = {}) {
    const previousPinned = new Set()
    if (preservePinned) {
      for (const [id, task] of this.tasks) if (task.pinned) previousPinned.add(id)
    }
    this.tasks = new Map()
    for (const task of tasks) {
      if (!task?.sessionId) continue
      const pinned = previousPinned.has(task.sessionId) || Boolean(task.pinned)
      this.tasks.set(task.sessionId, { ...task, pinned })
    }
    return this
  }

  upsertSessions(sessions) {
    for (const session of sessions) {
      if (!session?.sessionId) continue
      this.sessions.set(session.sessionId, {
        ...(this.sessions.get(session.sessionId) ?? {}),
        ...session,
      })
    }
    return this
  }

  removeSessions(ids) {
    for (const id of ids) {
      this.sessions.delete(id)
      this.tasks.delete(id)
      this.archived.delete(id)
    }
    return this
  }

  /** 归档：在列表上表现为"这条不见了"，而不是"这条已完成"。 */
  upsertArchived(ids) {
    for (const id of ids) {
      this.archived.add(id)
      this.sessions.delete(id)
      this.tasks.delete(id)
    }
    return this
  }
}

/** 任务索引的扁平视图（bootstrap / workspace-list 的 result.tasks 就是这种形状）。 */
export function taskFromFlat(raw) {
  if (!raw?.taskId) return null
  const workspace = raw.workspaceLabel || basename(raw.workspacePath)
  return {
    sessionId: raw.taskId,
    title: raw.title ?? '',
    workspace,
    phase: phaseFromStatus(raw.displayStatus) ?? raw.displayStatus ?? null,
    lastActivityAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
  }
}

/** 任务索引的嵌套视图（controller/tasks-index 的 delta.task 就是这种形状）。 */
export function taskFromNested(raw) {
  if (!raw) return null
  const address = raw.address ?? {}
  const meta = raw.meta ?? {}
  const membership = raw.membership ?? {}
  const activity = raw.activity ?? {}
  const sessionId = address.taskId ?? meta.taskId
  if (!sessionId) return null
  return {
    sessionId,
    title: meta.title ?? '',
    workspace: basename(address.workspacePath ?? meta.workspacePath),
    phase: activity.phase ?? raw.liveStatus ?? phaseFromStatus(meta.status),
    lastActivityAt: activity.lastActivityAt ?? meta.updatedAt ?? null,
    createdAt: meta.createdAt ?? null,
    pinned: Boolean(membership.pinned),
    archived: Boolean(membership.archived),
  }
}

/** Windows 与 POSIX 两种分隔符都要处理——桌面端可能跑在任一平台上。 */
export function basename(path) {
  const text = String(path ?? '')
  if (!text) return ''
  const parts = text.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : text
}
