/**
 * 端点会话管理：把中继客户端接到全局状态上，并负责重连。
 *
 * 分工：`RelaySession` 只管协议（认证、信封、桥接 RPC），本模块管"界面需要什么"——
 * 连接灯、任务列表、待办计数、通知、以及失败后的自动重连。
 *
 * 读路径（列表 / 索引 / 历史）依据 OSS 的方法名实现，可信度较高；
 * 写路径（发送 / 停止 / 审批）的**方法名与参数形状尚未在真机验证**，
 * 因此集中在 `actions` 里并标注，一旦真机探明只需改这一处。
 */

import { RelaySession, V4, CHANNEL_ZCODE_AGENT, uniConnect } from './relay-client.js'
import { indexOf, recompute, setLed, state, eventsForNotify } from '../store/app.js'
import { LED_ERROR, LED_LOADING, isTakeoverCode } from '../core/relay-led.js'
import { findTopicFrame, workspaceKeyFor } from '../core/topics.js'
import { notifyEvents } from './notify.js'

const sessions = new Map()
const retryTimers = new Map()
const waitingTimers = new Map()
const retryCount = new Map()

const MAX_BACKOFF_MS = 30000

/**
 * `pair_status=waiting` 时的重新握手间隔。
 *
 * 这个状态的含义是"认证通过了，但电脑端的远控腿没在线"——用户把 ZCode 的
 * 「移动端远程控制」页面重新打开后，中继腿就回来了，可我们这一侧是不知情地等着的。
 * 官方客户端靠 pair_status_query 探活，但那条查询发得不对会被直接 KICKED；
 * 相比之下重新握一次手是安全的（我们已经在日志里验证过它会正常返回 auth_ack），
 * 所以这里用"定期重新握手"来达到同样的效果：页面一开，15 秒内自动连上。
 */
const WAITING_RETRY_MS = 15000

export function sessionFor(endpointId) {
  return sessions.get(endpointId) ?? null
}

export function connectEndpoint(endpoint, { reconnect = true } = {}) {
  if (!endpoint) return null
  if (sessions.has(endpoint.id)) return sessions.get(endpoint.id)

  const session = new RelaySession({
    endpoint,
    connect: uniConnect,
    handlers: {
      onState: () => {},
      onLed: (led) => setLed(endpoint.id, led),
      onPairStatus: (pairStatus) => {
        if (pairStatus === 'matched') {
          clearRetry(endpoint.id)
          clearWaiting(endpoint.id)
          markStatus(endpoint.id, 'paired')
        } else {
          // 桌面端的「远程控制」页面关掉后中继腿就离线了，这既不是错误也不该重连轰炸；
          // 但要定期重新握一次手，页面一开就能自动接上。
          markStatus(endpoint.id, 'waiting')
          scheduleWaitingRetry(endpoint)
        }
      },
      onTasks: ({ tasks, replace, preservePinned }) => {
        const index = indexOf(endpoint.id)
        if (replace) index.replaceTasks(tasks.map(toTask), { preservePinned: Boolean(preservePinned) })
        else index.upsertTasks(tasks.map(toTask))
        recompute(endpoint.id)
      },
      onSessions: ({ upserts }) => {
        indexOf(endpoint.id).upsertSessions(upserts)
        recompute(endpoint.id)
        notifyEvents(endpoint.id, eventsForNotify(endpoint.id, upserts))
      },
      onSessionsRemoved: (ids) => {
        const index = indexOf(endpoint.id)
        index.removeSessions(ids)
        recompute(endpoint.id)
      },
      onArchived: (ids) => {
        indexOf(endpoint.id).upsertArchived(ids)
        recompute(endpoint.id)
      },
      onWorkspaces: (workspaces) => {
        state.workspaces = { ...(state.workspaces ?? {}), [endpoint.id]: workspaces }
      },
      onInitialView: (view) => {
        state.initialView = { ...(state.initialView ?? {}), [endpoint.id]: view }
      },
      onBridgeReady: (bridge, channel) => {
        clearBridgeError(endpoint.id)
        // 桥接就绪后必须**主动订阅**：会话索引与任务索引是订阅型的，
        // 不订阅桌面端就不会推，列表会停在 bootstrap 那一刻的快照上。
        autoSubscribe(endpoint.id, bridge, channel)
      },
      onBridgeFailed: (reason) => {
        setBridgeError(endpoint.id, reason)
      },
      onError: (error) => {
        state.lastError = { ...(state.lastError ?? {}), [endpoint.id]: error }
        if (isTakeoverCode(error.code)) {
          // 被别的客户端挤掉（通常是官方远控页面开着）。配对是好的，等一会儿再抢回来，
          // 但不要立刻重连——立刻重连会和对方形成互相踢的循环。
          markStatus(endpoint.id, 'kicked')
          scheduleTakeoverRetry(endpoint)
        }
      },
      onClosed: (event) => {
        setLed(endpoint.id, event.terminal ? LED_ERROR : LED_LOADING)
        if (event.terminal) {
          markStatus(endpoint.id, 'expired')
          sessions.delete(endpoint.id)
          return
        }
        sessions.delete(endpoint.id)
        if (reconnect) scheduleReconnect(endpoint, reconnect)
      },
    },
  })

  setLed(endpoint.id, LED_LOADING)
  markStatus(endpoint.id, 'connecting')
  session.start()
  sessions.set(endpoint.id, session)
  return session
}

function toTask(task) {
  return { ...task }
}

/**
 * 桥接就绪后订阅控制器与会话。
 *
 * 用 promise 链而不是 await：订阅是否成功不影响连接本身，失败只记日志
 * （诊断页会显示"rpc response"与超时错误，据此判断通道名/方法名对不对）。
 */
function autoSubscribe(endpointId, bridge, channel) {
  const note = (text) => sessions.get(endpointId)?.pushLog('·', text)
  const ch = channel.getChannel(CHANNEL_ZCODE_AGENT)

  ch.call(V4.controllerSubscribe, connectionParams(endpointId))
    .then(() => note('controller/subscribe ok'))
    .catch((error) => note(`controller/subscribe failed: ${error?.message ?? error}`))

  if (bridge?.initialTaskId) {
    ch.call(V4.conversationSubscribe, connectionParams(endpointId, { sessionId: bridge.initialTaskId }))
      .then(() => note(`conversation/subscribe ok task=${bridge.initialTaskId}`))
      .catch((error) => note(`conversation/subscribe failed: ${error?.message ?? error}`))
  }
}

export function disconnectEndpoint(endpointId) {
  clearRetry(endpointId)
  clearWaiting(endpointId)
  const session = sessions.get(endpointId)
  if (!session) return
  session.stop()
  sessions.delete(endpointId)
}

export function disconnectAll() {
  for (const id of [...sessions.keys()]) disconnectEndpoint(id)
}

/**
 * 重连退避。
 *
 * 上限 30 秒而不是无限拉长：这类应用的使用方式是"掏出来看一眼"，
 * 用户回到前台时最多等半分钟就能看到状态，比指数退避到几分钟更合适。
 */
function scheduleReconnect(endpoint, enabled) {
  if (!enabled) return
  clearRetry(endpoint.id)
  const count = (retryCount.get(endpoint.id) ?? 0) + 1
  retryCount.set(endpoint.id, count)
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(count, 5))
  const timer = setTimeout(() => {
    retryTimers.delete(endpoint.id)
    markStatus(endpoint.id, 'connecting')
    connectEndpoint(endpoint, { reconnect: true })
  }, delay)
  retryTimers.set(endpoint.id, timer)
}

function clearRetry(endpointId) {
  const timer = retryTimers.get(endpointId)
  if (timer) clearTimeout(timer)
  retryTimers.delete(endpointId)
  retryCount.delete(endpointId)
}

/** 注册"等待桌面端"期间的定期重新握手；同一端点同时只允许一个。 */
function scheduleWaitingRetry(endpoint) {
  if (waitingTimers.has(endpoint.id)) return
  const timer = setTimeout(() => {
    waitingTimers.delete(endpoint.id)
    // 重新握手前先确认还没连上（用户可能已经手动重连或页面已恢复）。
    if (statusOf(endpoint.id) === 'paired') return
    disconnectEndpoint(endpoint.id)
    connectEndpoint(endpoint)
    scheduleWaitingRetry(endpoint)
  }, WAITING_RETRY_MS)
  waitingTimers.set(endpoint.id, timer)
}

function clearWaiting(endpointId) {
  const timer = waitingTimers.get(endpointId)
  if (timer) clearTimeout(timer)
  waitingTimers.delete(endpointId)
}

/**
 * 被接管后的重试。
 *
 * 间隔比 waiting 的 15 秒长：对方（官方页面）可能正被用户使用着，
 * 频繁抢连接只会让两边都不可用。用户关掉那个页面后，这里自然会连上。
 */
const TAKEOVER_RETRY_MS = 20000

function scheduleTakeoverRetry(endpoint) {
  if (waitingTimers.has(endpoint.id)) return
  const timer = setTimeout(() => {
    waitingTimers.delete(endpoint.id)
    disconnectEndpoint(endpoint.id)
    connectEndpoint(endpoint)
  }, TAKEOVER_RETRY_MS)
  waitingTimers.set(endpoint.id, timer)
}

function markStatus(endpointId, status) {
  state.pairStatus = { ...(state.pairStatus ?? {}), [endpointId]: status }
}

export function statusOf(endpointId) {
  return state.pairStatus?.[endpointId] ?? 'connecting'
}

// ---------------------------------------------------------------------------
// 读路径
// ---------------------------------------------------------------------------

/**
 * 解析某个会话所属工作区的**完整键**。
 *
 * 这里曾经是本项目最要命的一个 bug：桥接打开时传的是工作区的 basename（`demo`），
 * 而中继要的是完整键（`W:\ws\demo`）——症状恰好就是用户报的"连上了但看不到会话内容"：
 * 桥接永远等不到 ready，界面只能一直等。三个来源按可靠性排序：
 *   1. 任务行里带的完整路径（用完整路径去问 bridge-open）；
 *   2. bootstrap 的 initialViewState.activeWorkspaceKey（桌面端此刻正在看的那个）；
 *   3. 会话索引主题路径里带的键。
 */
export function resolveWorkspaceKey(endpointId, sessionId) {
  const session = sessions.get(endpointId)
  const taskRow = (state.tasks[endpointId] ?? []).find((task) => task.sessionId === sessionId)
  const sessionRow = (state.sessions[endpointId] ?? []).find((item) => item.sessionId === sessionId)
  const wanted = {
    workspaceKey: taskRow?.workspaceKey || sessionRow?.workspaceKey || '',
    workspace: taskRow?.workspace || sessionRow?.workspace || '',
  }

  // 权威来源优先：`workspace-list` 回复里的 `workspaces` 数组是"窗口里有哪些工作区"的
  // 定义，重连要的键出自这里；任务里的 workspacePath 只是任务归属的路径。
  const fromList = workspaceKeyFor(session?.workspaces, wanted)
  if (fromList) return fromList

  return wanted.workspaceKey || state.initialView?.[endpointId]?.activeWorkspaceKey || ''
}

/**
 * 确保工作区桥接已打开。已经开过就直接返回，不重复发请求。
 *
 * @returns {{ok:boolean, bridge?:object, reason?:string}}
 */
export function ensureBridge(endpointId, { sessionId, workspaceKey } = {}) {
  const session = sessions.get(endpointId)
  if (!session) return { ok: false, reason: '端点未连接' }
  if (session.channel) return { ok: true, bridge: session.bridge }

  const key = workspaceKey || resolveWorkspaceKey(endpointId, sessionId)
  if (!key) {
    return {
      ok: false,
      reason: '拿不到工作区完整路径：任务列表里没带 workspacePath，bootstrap 也没给出 activeWorkspaceKey。诊断页里有原始帧。',
    }
  }
  const bridge = session.openWorkspaceBridge(key, sessionId)
  return { ok: true, bridge }
}

/** 桥接是否就绪（诊断与界面判断用）。 */
export function bridgeState(endpointId) {
  const session = sessions.get(endpointId)
  if (!session) return { connected: false }
  return {
    connected: true,
    state: session.state,
    led: session.led,
    channelReady: Boolean(session.channel),
    bridge: session.bridge ?? null,
    workspaces: session.workspaces ?? [],
    taskCount: (state.tasks[endpointId] ?? []).length,
  }
}

function setBridgeError(endpointId, reason) {
  state.bridgeError = { ...(state.bridgeError ?? {}), [endpointId]: reason }
}

function clearBridgeError(endpointId) {
  if (!state.bridgeError?.[endpointId]) return
  const next = { ...state.bridgeError }
  delete next[endpointId]
  state.bridgeError = next
}

/** 桥接失败时电脑端给出的原话；没有失败则为空。 */
export function bridgeErrorOf(endpointId) {
  return state.bridgeError?.[endpointId] ?? ''
}

/** 诊断：最近若干条收发帧。 */
export function logFor(endpointId, limit = 120) {
  const session = sessions.get(endpointId)
  if (!session) return []
  return session.log.slice(-limit)
}

/** 诊断：用阶段一的通用方法代理试探桌面端暴露了哪些方法。 */
export async function tryPlatform(endpointId, method, args = {}) {
  const session = sessions.get(endpointId)
  if (!session) throw new Error('端点未连接')
  return session.platformCall(method, args)
}

/** 把行参数换成 OSS 里的真实形状。 */
function connectionParams(endpointId, extra = {}) {
  const session = sessions.get(endpointId)
  const bridge = session?.bridge
  return {
    // host 会为每个下游客户端分配 connectionId；桥接身份就是我们这条连接。
    connectionId: bridge?.bridgeSessionId ?? '',
    clientMode: 'web-remote-replayable',
    ...extra,
  }
}

/**
 * 拉一窗会话行（`v4/conversation/rowsRange`）。参数形状来自 OSS 的
 * `v4ConversationRowsRangeParamsSchema`：`{sessionId, beforeRowId?, limit}`，
 * 其中 **limit 必填**（1..200），`beforeRowId` 是"取 rowId 小于它的行"的游标，
 * 省略即从当前尾部向前。
 */
function rowsParams(sessionId, limit) {
  return { sessionId, limit: Math.min(Math.max(1, limit), 200) }
}

/**
 * 读一窗会话行，**两条路都试**。
 *
 *   1. 桥接通道（阶段二，`v4/conversation/rowsRange`）；
 *   2. 阶段一的通用方法代理 `platform-request`——早期协议笔记里其实写过
 *      "数据面即 bootstrap/platform-request 通道，无需 VSCode RPC 栈"，
 *      而真机上桥接一直没有回应，所以这条老结论值得认真试。
 *
 * 谁先给出可用结果就用谁，并把走的哪条路交给界面显示——省得下次又只能猜。
 *
 * @returns {{via:'bridge'|'platform'|'none', payload?:any, error?:string}}
 */
export async function readRows(endpointId, sessionId, { limit = 200 } = {}) {
  const session = sessions.get(endpointId)
  if (!session) return { via: 'none', error: '端点未连接' }
  const params = rowsParams(sessionId, limit)

  if (session.channel) {
    try {
      const payload = await session.channel.getChannel(CHANNEL_ZCODE_AGENT).call(V4.conversationRowsRange, params)
      return { via: 'bridge', payload }
    } catch (error) {
      // 桥接不通不是终点，继续试 platform——这条错误只记日志。
      session.pushLog('!', `bridge rowsRange failed: ${error?.message ?? error}`)
    }
  }

  try {
    const response = await session.platformCall('v4/conversation/rowsRange', params)
    if (response?.success === false) {
      return { via: 'platform', error: String(response.error ?? '电脑端返回失败') }
    }
    // platform-response 的载荷可能是 {result} 或直接就是结果。
    return { via: 'platform', payload: response?.result ?? response }
  } catch (error) {
    return { via: 'none', error: String(error?.message ?? error) }
  }
}

/** 只走 platform-request 的读取（诊断页用，便于单独验证这条路）。 */
export async function readRowsViaPlatform(endpointId, sessionId, { limit = 50 } = {}) {
  const session = sessions.get(endpointId)
  if (!session) throw new Error('端点未连接')
  return session.platformCall(V4.conversationRowsRange, rowsParams(sessionId, limit))
}

/** 桥接通道是否已就绪。 */
export function hasChannel(endpointId) {
  return Boolean(sessions.get(endpointId)?.channel)
}

/** 订阅会话实时帧（`v4/conversation/subscribe`）。 */
export function subscribeConversation(endpointId, sessionId, onFrame) {
  const session = sessions.get(endpointId)
  if (!session?.channel) return () => {}
  const channel = session.channel.getChannel(CHANNEL_ZCODE_AGENT)
  return channel.listen(V4.conversationSubscribe, connectionParams(endpointId, { sessionId }), onFrame)
}

/** 订阅控制器（`v4/controller/subscribe`）。 */
export function subscribeController(endpointId, onEvent) {
  const session = sessions.get(endpointId)
  if (!session?.channel) return () => {}
  const channel = session.channel.getChannel(CHANNEL_ZCODE_AGENT)
  return channel.listen(V4.controllerSubscribe, connectionParams(endpointId), onEvent)
}

// ---------------------------------------------------------------------------
// 写路径（方法名与参数形状待真机验证）
// ---------------------------------------------------------------------------

/**
 * 通过桥接发一条 v4 命令。
 *
 * 这一层的形状来自 OSS 的 `zcode-protocol-v4/command.ts` 与 `input-intent.ts`
 * （命令类型至少包含 sendText / resolveInteraction），但**尚未在真机跑通**：
 * 命令信封的字段名与必填项需要对着真实桌面端确认。所有写操作都收在这里，
 * 探明之后只改这一个函数。
 */
export async function sendCommand(endpointId, command) {
  const session = sessions.get(endpointId)
  if (!session?.channel) throw new Error('尚未连接')
  const channel = session.channel.getChannel(CHANNEL_ZCODE_AGENT)
  return channel.call(V4.command, command)
}

export async function sendText(endpointId, sessionId, text, extra = {}) {
  return sendCommand(endpointId, {
    type: 'sendText',
    sessionId,
    text,
    ...extra,
  })
}

export async function stopSession(endpointId, sessionId) {
  return sendCommand(endpointId, { type: 'stop', sessionId })
}

export async function resolveInteraction(endpointId, sessionId, interactionId, outcome) {
  return sendCommand(endpointId, {
    type: 'resolveInteraction',
    sessionId,
    interactionId,
    outcome: outcome === 'approve' ? 'approve' : 'reject',
  })
}

// ---------------------------------------------------------------------------
// 调试辅助
// ---------------------------------------------------------------------------

/** 收到一帧原始文本时调用，便于在真机上核对协议（开发用，不在界面上暴露）。 */
export function feedRaw(endpointId, text) {
  const session = sessions.get(endpointId)
  if (!session) return
  session.onSocketMessage(text)
}

export function lastTopicFrame(root) {
  return findTopicFrame(root)
}
