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
import { ENDPOINT_KIND_RELAY } from '../core/pairing-link.js'
import { CLOSE_DESKTOP_GONE, CLOSE_REPAIR, CLOSE_TAKEOVER, LED_ERROR, LED_LOADING, isTakeoverCode } from '../core/relay-led.js'
import { findTopicFrame, parseTaskDeltas, workspaceKeyFor } from '../core/topics.js'
import { notifyEvents } from './notify.js'

const sessions = new Map()
const retryTimers = new Map()
const waitingTimers = new Map()
const waitingCounts = new Map()
const retryCount = new Map()

const MAX_BACKOFF_MS = 30000

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
        handshakeAndSubscribe(endpoint.id, bridge, channel)
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
        sessions.delete(endpoint.id)

        // 四种关闭分开处理。把它们混成一个"终态"曾经导致：
        // 另一个客户端占着设备（SessionConflict）被报成「配对已失效」，
        // 而用户的链接完全没问题——他会一眼看出我们在胡说。
        if (event.kind === CLOSE_REPAIR || event.terminal) {
          markStatus(endpoint.id, 'expired')
          return
        }
        if (event.kind === CLOSE_TAKEOVER) {
          markStatus(endpoint.id, 'kicked')
          scheduleTakeoverRetry(endpoint)
          return
        }
        if (event.kind === CLOSE_DESKTOP_GONE) {
          markStatus(endpoint.id, 'waiting')
          scheduleWaitingRetry(endpoint)
          return
        }
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
 * 桥接握手 + 订阅（对齐官方 bundle 的 `UC` 函数与 ensureHandshake 流程）。
 *
 * 官方顺序（缺一步，后面全部无响应）：
 *   1. Initialize(200) 由桌面端主动推来（ChannelClient 收到后置 ready）；
 *   2. `helloConversationV4()` —— 响应里有**桌面端分配的 connectionId 与 clientMode**；
 *      我曾用自己编的 bridgeSessionId 冒充 connectionId，订阅因此被拒；
 *   3. `initializeConversationV4({kind:'clientHello', ...})` —— clientKind 按协商结果取
 *      （web-remote-replayable → 'web'，不是 'mobileRemote'）；appVersion 官方就是 'unknown'；
 *   4. 之后才允许订阅与读行。
 *
 * 参数形状：官方服务代理把参数**包在一层数组里**发（`e.call(r, [obj])`），所以
 * hello 的线上参数是空数组 `[]`，其余是 `[参数对象]`。
 */
async function handshakeAndSubscribe(endpointId, bridge, channel) {
  const note = (text) => sessions.get(endpointId)?.pushLog('·', text)
  const session = sessions.get(endpointId)
  const ch = channel.getChannel(CHANNEL_ZCODE_AGENT)

  try {
    const hello = await ch.call(V4.hello, [])
    const connectionId = hello?.connectionId ?? ''
    const clientMode = hello?.clientMode ?? 'web-remote-replayable'
    if (!connectionId) {
      note('hello 响应里没有 connectionId，订阅可能被拒')
    }
    session.connectionInfo = { connectionId, clientMode }
    note(`hello ok mode=${clientMode} conn=${connectionId.slice(0, 8)}…`)

    await ch.call(V4.initialize, [
      {
        kind: 'clientHello',
        protocolVersion: 3,
        clientId: bridge?.bridgeSessionId ?? connectionId,
        clientKind: clientMode === 'desktop-continuous' ? 'desktop' : 'web',
        appVersion: 'unknown',
        capabilities: { workspaceHookReviewUi: true },
      },
    ])
    note('clientHello ok')
  } catch (error) {
    note(`握手失败：${error?.message ?? error}`)
    // 握手失败也继续订阅——错误已经进了日志，界面能看到。
  }

  if (session.connectionInfo?.connectionId && bridge?.initialTaskId) {
    subscribeConversation(endpointId, bridge.initialTaskId, () => {})
  }
  subscribeController(endpointId, CONTROLLER_TOPIC_TASKS, (frame) => {
    const payload = frame?.payload ?? {}
    const { upserts, removes, archived } = parseTaskDeltas(payload)
    const index = indexOf(endpointId)
    if (upserts.length) index.upsertTasks(upserts)
    if (removes.length) index.removeSessions(removes)
    if (archived.length) index.upsertArchived(archived)
    if (upserts.length || removes.length || archived.length) recompute(endpointId)
  })
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

/**
 * `pair_status=waiting` 时的重新握手间隔——**递进加速**而不是固定 15 秒。
 *
 * 为什么：waiting 的最常见成因是桌面端远控页面的 WebSocket 掉线重连的**短暂窗口**
 * （窗口最小化时 Electron 节流后台页面、Windows 睡眠唤醒、网络抖动）——
 * 真机日志里同一个 sid、电脑端没动，一次握手 waiting、十几分钟后的另一次 matched。
 * 这种窗口通常一两秒就过去，固定 15 秒会把"本该 2 秒恢复"变成"用户盯着等待看 15 秒"，
 * 表现正好是"进软件没法第一时间连接，可电脑端明明开着"。
 */
const WAITING_RETRY_STEPS = [2000, 4000, 8000, 15000]

/** 第 count 次等待后的重试延迟。抽成纯函数以便单测钉住递进节奏。 */
export function waitingRetryDelay(count) {
  const step = Math.min(Math.max(0, count), WAITING_RETRY_STEPS.length - 1)
  return WAITING_RETRY_STEPS[step]
}

/** 注册"等待桌面端"期间的定期重新握手；同一端点同时只允许一个。 */
function scheduleWaitingRetry(endpoint) {
  if (waitingTimers.has(endpoint.id)) return
  const count = waitingCounts.get(endpoint.id) ?? 0
  const delay = waitingRetryDelay(count)
  waitingCounts.set(endpoint.id, count + 1)
  sessions.get(endpoint.id)?.pushLog('·', `pair waiting，${delay}ms 后重新握手`)
  const timer = setTimeout(() => {
    waitingTimers.delete(endpoint.id)
    // 重新握手前先确认还没连上（用户可能已经手动重连或页面已恢复）。
    if (statusOf(endpoint.id) === 'paired') return
    disconnectEndpoint(endpoint.id)
    connectEndpoint(endpoint)
    scheduleWaitingRetry(endpoint)
  }, delay)
  waitingTimers.set(endpoint.id, timer)
}

function clearWaiting(endpointId) {
  const timer = waitingTimers.get(endpointId)
  if (timer) clearTimeout(timer)
  waitingTimers.delete(endpointId)
  waitingCounts.delete(endpointId)
}

/**
 * 回到前台时立即恢复连接。
 *
 * 场景：用户切出去几分钟再回来——此时要么 waiting 计时器还在慢悠悠地走，
 * 要么进程已被系统杀掉而 onLaunch 已经接上。对前一种，这里立即重新握手一次，
 * 不让用户等剩下的计时；对后一种，onLaunch 已经处理，这里跳过。
 */
export function resumeConnections() {
  for (const endpoint of state.list) {
    if (endpoint.kind !== ENDPOINT_KIND_RELAY) continue
    const status = statusOf(endpoint.id)
    // paired 不用动；expired 要用户重新配对，自动重试无意义；
    // connecting 说明握手正在进行，打断它反而坏事。
    if (status === 'paired' || status === 'expired' || status === 'connecting') continue
    disconnectEndpoint(endpoint.id)
    connectEndpoint(endpoint)
  }
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

/** 把行参数换成官方形状。connectionId 用 **hello 响应里桌面端分配的**，不是自编的。 */
function connectionParams(endpointId, extra = {}) {
  const session = sessions.get(endpointId)
  const info = session?.connectionInfo ?? {}
  return {
    connectionId: info.connectionId ?? '',
    clientMode: info.clientMode ?? 'web-remote-replayable',
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
 * 读一窗会话行（`v4/conversation/rowsRange`），走桥接通道。
 *
 * 曾经这里还试过一条"用 `platform-request` 代理 v4 方法"的退路，**现已删除**：
 * 从官方前端 bundle 里查到 `platform-request.method` 是一个只有 7 个值的枚举
 * （`isDockerAvailable` / `listWSLDistros` / `listDockerContainers` /
 * `listSSHConfigAliases` / `loadMcpFromUserDirectory` / `saveMcpToUserDirectory` /
 * `migrateLegacyCommonMcp`），它**不是**通用 RPC 代理。用 `v4/conversation/rowsRange`
 * 去问必然被无视，白等 8 秒超时，还会把"读取失败"的真实原因盖住。
 * 会话内容只能经桥接通道读，所以这里只做一件事，失败就如实报原因。
 */
export async function readRows(endpointId, sessionId, { limit = 200 } = {}) {
  const session = sessions.get(endpointId)
  if (!session) return { via: 'none', error: '端点未连接' }

  if (!session.channel) {
    return { via: 'none', error: '桥接通道未就绪（会话内容只能经桥接读取）' }
  }

  try {
    // 官方服务代理把参数包在一层数组里发：`e.call(name, [params])`。
    const payload = await session.channel
      .getChannel(CHANNEL_ZCODE_AGENT)
      .call(V4.conversationRowsRange, [rowsParams(sessionId, limit)])
    return { via: 'bridge', payload }
  } catch (error) {
    return { via: 'bridge', error: String(error?.message ?? error) }
  }
}

/** 桥接通道是否已就绪。 */
export function hasChannel(endpointId) {
  return Boolean(sessions.get(endpointId)?.channel)
}

/** 订阅会话实时帧（`subscribeConversationV4`）。
 *
 * 官方把订阅当**普通 Promise 调用**发（不是 EventListen），响应是
 * `{ack:{subscriptionId}}`；之后的增量帧由桌面端以 EventFire 推来。
 * 这里发订阅并保留 ack；帧路由由 unmatched-event 通道处理。
 */
export function subscribeConversation(endpointId, sessionId, onFrame) {
  const session = sessions.get(endpointId)
  if (!session?.channel) return () => {}
  const channel = session.channel.getChannel(CHANNEL_ZCODE_AGENT)
  channel
    .call(V4.conversationSubscribe, [connectionParams(endpointId, { sessionId })])
    .then((ack) => sessions.get(endpointId)?.pushLog('·', `conversation subscribe ack=${JSON.stringify(ack).slice(0, 120)}`))
    .catch((error) => sessions.get(endpointId)?.pushLog('!', `conversation subscribe failed: ${error?.message ?? error}`))
  return session.addConversationListener(sessionId, onFrame)
}

/**
 * 订阅控制面（`subscribeControllerV4`）。
 *
 * 官方调用：`subscribeControllerV4({topic:'controller/tasks-index', visibility:'foreground'})`——
 * 同样是 **Promise 调用 + 包一层数组**，不是 EventListen。
 * topic 是 `controller/tasks-index`（任务实时增量）这类字符串。
 */
export const CONTROLLER_TOPIC_TASKS = 'controller/tasks-index'

/** 控制面订阅的线级参数。抽成纯函数以便单测钉住形状。 */
export function controllerSubscribeParams(topic) {
  return { topic, visibility: 'foreground' }
}

export function subscribeController(endpointId, topic, onEvent) {
  const session = sessions.get(endpointId)
  if (!session?.channel) return () => {}
  session.channel
    .getChannel(CHANNEL_ZCODE_AGENT)
    .call(V4.controllerSubscribe, [controllerSubscribeParams(topic)])
    .catch((error) => session.pushLog('!', `controller subscribe failed: ${error?.message ?? error}`))
  return session.addTopicListener(topic, onEvent)
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
