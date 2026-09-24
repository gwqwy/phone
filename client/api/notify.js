/**
 * 系统通知。
 *
 * 平台限制必须先说清楚，因为它决定了这里能做到什么程度：
 * uni/HTML5+ 只能创建本地通知、只能整体清除（`plus.push.clear()`），**没有按 id 撤回的 API**。
 * 所以本模块的策略是：
 *   - 每个「端点 × 类型 × 会话」占一个槽位，同一槽位重复触发时只更新内容，不刷屏；
 *   - 撤回时把槽位从活跃集合里去掉；**当且仅当活跃集合清空**才 clear()，
 *     否则保留（因为清掉会把其他还等着处理的审批一起抹掉，比不撤更糟）。
 * 想做到上游那种精确撤回，需要引入原生插件改写通知 ID，这在 v0.1.0 的范围之外。
 */

import { NOTIFIABLE, notificationSlot } from '../core/event-differ.js'
import { t } from '../store/app.js'

/** 活跃槽位：endpointId -> Map<slotKey, {type, sessionId, label, summary}> */
const active = new Map()

function canNotify() {
  return typeof plus !== 'undefined' && typeof plus.push?.createMessage === 'function'
}

export function notifyEvents(endpointId, events) {
  if (!Array.isArray(events) || !events.length) return
  const slots = active.get(endpointId) ?? new Map()
  active.set(endpointId, slots)

  for (const event of events) {
    if (event.type === 'resolved') {
      retract(endpointId, event.sessionId)
      continue
    }
    if (!NOTIFIABLE.has(event.type)) continue
    const slot = notificationSlot(endpointId, event.type, event.sessionId)
    slots.set(slot, event)
    showNotification(event)
  }
}

function showNotification(event) {
  if (!canNotify()) return
  const title = titleFor(event)
  const content = event.summary || bodyFor(event)
  try {
    plus.push.createMessage(content, JSON.stringify({ endpointId: event.endpointId, sessionId: event.sessionId }), {
      title,
      // 审批是阻塞性的，必须能被听见；完成类只要出现在通知栏即可。
      sound: event.type === 'permission_request' || event.type === 'elicitation_request' ? 'system' : 'none',
      cover: false,
    })
  } catch {
    /* 通知权限被拒时静默——界面内的未读徽标仍然工作 */
  }
}

function titleFor(event) {
  switch (event.type) {
    case 'permission_request':
      return t('pendingApproval')
    case 'elicitation_request':
      return t('pendingInput')
    case 'completed':
      return t('notifyComplete')
    case 'error':
      return t('notifyFail')
    default:
      return t('appName')
  }
}

function bodyFor(event) {
  return event.label || event.sessionId
}

/**
 * 撤回。
 *
 * 返回是否真的从通知栏撤掉了——调用方（界面）可以据此决定要不要在应用内
 * 用一条"已解决"的提示补齐信息。
 */
export function retract(endpointId, sessionId) {
  const slots = active.get(endpointId)
  if (!slots) return false
  for (const [key, event] of [...slots.entries()]) {
    if (event.sessionId !== sessionId) continue
    slots.delete(key)
  }
  if (slots.size === 0 && canNotify()) {
    try {
      plus.push.clear()
      return true
    } catch {
      return false
    }
  }
  return false
}

/** 用户打开某个端点时调用：界面上看过就算已读。 */
export function clearEndpoint(endpointId) {
  const slots = active.get(endpointId)
  if (!slots || slots.size === 0) return
  slots.clear()
  if (canNotify()) {
    try {
      plus.push.clear()
    } catch {
      /* 忽略 */
    }
  }
}

export function clearAll() {
  active.clear()
  if (canNotify()) {
    try {
      plus.push.clear()
    } catch {
      /* 忽略 */
    }
  }
}

export function activeCount(endpointId) {
  return active.get(endpointId)?.size ?? 0
}
