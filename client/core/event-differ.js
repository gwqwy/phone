/**
 * 通知差分器。
 *
 * 通知的难点不是"发出去"，而是**准确的发和准确的撤**。规则来自上游 zremote 的实测：
 *
 *   - 待办计数 0→>0 才通知（审批请求、需要输入）；
 *   - 计数归零才撤回（>0→0）；2→1 这种减少不通知也不撤回——用户还在处理中；
 *   - 阶段进入终态（完成/失败）时通知，但**首次见到就是终态的不通知**
 *     （刚打开 App 就被一堆历史完成记录刷屏，是这类应用最经典的体验事故）；
 *   - 会话被移除且当时有待办 ⇒ 视作「已解决」，撤掉通知；
 *   - 一次不含任何会话信息的帧不能把上一次的状态抹掉，否则下一帧会被误判成 0→>0。
 */

import { PHASE_COMPLETED, PHASE_ERROR, PHASE_INTERRUPTED, isDone, isError } from './session-index.js'

export const EVENT_PERMISSION = 'permission_request'
export const EVENT_ELICITATION = 'elicitation_request'
export const EVENT_COMPLETED = 'completed'
export const EVENT_ERROR = 'error'
export const EVENT_RESOLVED = 'resolved'

/** 可通知的事件类型。resolved 不在其中——它只用来撤回，不该自己发一条。 */
export const NOTIFIABLE = new Set([EVENT_PERMISSION, EVENT_ELICITATION, EVENT_COMPLETED, EVENT_ERROR])

export class StateDiffer {
  constructor() {
    this.prev = new Map()
  }

  /**
   * @param {Array<object>} states 本次解析出的会话状态
   * @returns {Array<{type:string, sessionId:string, label:string, summary:string}>}
   */
  apply(states) {
    const events = []
    if (!Array.isArray(states) || states.length === 0) return events

    const seen = new Set()
    for (const state of states) {
      const id = state?.sessionId
      if (!id) continue
      seen.add(id)

      const before = this.prev.get(id)
      const after = {
        phase: state.phase ?? null,
        permissionCount: state.permissionCount ?? 0,
        userInputCount: state.userInputCount ?? 0,
      }

      const permissionDelta = after.permissionCount - (before?.permissionCount ?? 0)
      const inputDelta = after.userInputCount - (before?.userInputCount ?? 0)

      // 首次见到时就带着待办，也要通知——这不是"历史记录"，是此刻正等着你。
      if (after.permissionCount > 0 && (permissionDelta > 0 || !before)) {
        events.push(event(EVENT_PERMISSION, state))
      } else if (after.userInputCount > 0 && (inputDelta > 0 || !before)) {
        events.push(event(EVENT_ELICITATION, state))
      }

      if (before) {
        if (before.permissionCount > 0 && after.permissionCount === 0) {
          events.push(event(EVENT_RESOLVED, state))
        } else if (before.userInputCount > 0 && after.userInputCount === 0) {
          events.push(event(EVENT_RESOLVED, state))
        }

        if (isError(after.phase) && !isError(before.phase)) {
          events.push(event(EVENT_ERROR, state))
        } else if (isDone(after.phase) && !isDone(before.phase)) {
          events.push(event(EVENT_COMPLETED, state))
        }
        // 首次见到终态：只登记，不通知。
      }

      this.prev.set(id, after)
    }
    return events
  }

  /** 会话被显式移除：当时有待办就撤回对应通知。 */
  remove(sessionId) {
    const before = this.prev.get(sessionId)
    this.prev.delete(sessionId)
    if (!before) return []
    if (before.permissionCount > 0 || before.userInputCount > 0) {
      return [{ type: EVENT_RESOLVED, sessionId, label: '', summary: '' }]
    }
    return []
  }

  forget(sessionId) {
    this.prev.delete(sessionId)
  }

  reset() {
    this.prev.clear()
  }
}

function event(type, state) {
  return {
    type,
    sessionId: state.sessionId,
    label: state.title || state.workspace || state.sessionId,
    summary: state.description || state.toolName || '',
  }
}

/**
 * 通知开关。
 *
 * 默认只开审批：完成与失败在长时间运行的任务里会非常吵，而"等你审批"是真的在阻塞。
 */
export const DEFAULT_NOTIFY_PREFS = {
  approval: true,
  complete: false,
  fail: false,
}

export function shouldNotify(type, prefs = DEFAULT_NOTIFY_PREFS) {
  switch (type) {
    case EVENT_PERMISSION:
    case EVENT_ELICITATION:
      return Boolean(prefs.approval)
    case EVENT_COMPLETED:
      return Boolean(prefs.complete)
    case EVENT_ERROR:
      return Boolean(prefs.fail)
    default:
      return false
  }
}

/** 通知槽位键：同一「端点 × 类型 × 会话」共用一条通知，原地更新而不是刷屏。 */
export function notificationSlot(endpointId, type, sessionId) {
  return `shou|${endpointId}|${type}|${sessionId ?? ''}`
}

/** 撤回一对槽位：审批与输入请求都归零时要一起撤。 */
export function retractableSlots(endpointId, sessionId) {
  return [
    notificationSlot(endpointId, EVENT_PERMISSION, sessionId),
    notificationSlot(endpointId, EVENT_ELICITATION, sessionId),
  ]
}
