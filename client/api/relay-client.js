/**
 * ZCode 官方中继客户端。
 *
 * 协议分两段，两段都实现，但**验证程度不同**，代码里逐段注明：
 *
 *   阶段一 · JSON 信封（已实测可用）
 *     auth_init → auth_challenge → auth_response → auth_ack(pair_status)
 *     bootstrap-request / workspace-list-request / platform-request / workspace-bridge-open
 *
 *   阶段二 · 桥接内的 RPC（编码层已按 OSS 逐行核对，尚未在真机跑通）
 *     workspace-bridge-ready 之后，用 13 字节帧头 + channel 载荷承载 v4 方法
 *     （v4/controller/subscribe、v4/conversation/rowsRange、v4/command…）。
 *
 * 设计上刻意把 socket 注入进来：传输层（uni.connectSocket / 测试用的假 socket）
 * 换掉之后，认证与状态机都能在 Node 下单测，不需要真设备。
 */

import { base64, base64Decode, hmacSha256, utf8 } from '../core/crypto.js'
import { crc32Hex } from '../core/crc32.js'
import { FrameReader, ProtocolMessageType, ChannelClient, decodeResponse, writeFrame } from '../core/rpc-wire.js'
import {
  CLOSE_REPAIR,
  LED_ERROR,
  LED_LIVE,
  LED_LOADING,
  classifyClose,
  onFrameRoot,
} from '../core/relay-led.js'
import {
  FragmentAssembler,
  findEnvelope,
  findTopicFrame,
  isBootstrapResult,
  parseFlatTasks,
  parseFrameText,
  parseSessionDeltas,
  parseTaskDeltas,
  parseWorkspaces,
} from '../core/topics.js'
import { buildPairingUrl, HASH_KEY, SID_KEY } from '../core/pairing-link.js'
import { parseLink } from '../core/url.js'

export const RELAY_URL = 'wss://zcode.z.ai/ws'
export const RELAY_FALLBACK_URL = 'wss://zcode.chatglm.site/ws'

/**
 * 从中继端点推出 WebSocket 地址。
 *
 * 不写死官方域名：配对链接的 host 就是中继的 host（自建中继是一等公民，
 * 端口与路径都必须保留），官方链接自然算出 `wss://zcode.z.ai/ws`。
 */
export function relayWsUrl(endpoint) {
  const parsed = parseLink(endpoint?.baseUrl)
  if (!parsed) return RELAY_URL
  const scheme = parsed.scheme === 'http' ? 'ws' : 'wss'
  const port = parsed.port === null ? '' : `:${parsed.port}`
  return `${scheme}://${parsed.host}${port}/ws`
}

/** 诊断日志上限：够看清一次连接的全过程，又不至于把内存吃掉。 */
const MAX_LOG = 120
const MAX_LOG_TEXT = 600

/** 服务通道名（OSS `packages/shared/src/channels.ts` 的 ServiceChannels.ZCodeAgent）。 */
export const CHANNEL_ZCODE_AGENT = 'zcode-agent'

/**
 * v4 服务方法名。
 *
 * **这里是官方移动端桥接上的真实方法名**——从官方 bundle 的服务代理实现逐字核对：
 * `toService` 用 `new Proxy({get: (n, r) => (...args) => channel.call(r, args)})` 把
 * **属性名原样**作为线上 method 发出去，所以官方 UI 调 `e.conversationRowsRangeV4(...)`
 * 意味着线上方法名就是 `conversationRowsRangeV4`（camelCase + V4 后缀）。
 *
 * OSS `V4_METHODS` 里那套 `v4/conversation/rowsRange` 是 **host 通道层**（桌面
 * renderer→CLI 的 NDJSON/stdio）的名字，与桥接并存但不是同一个面。我曾拿它发到
 * 桥接上——方法不存在，桌面端无响应，这就是 rowsRange 一直石沉大海的根因。
 */
export const V4 = {
  hello: 'helloConversationV4',
  initialize: 'initializeConversationV4',
  controllerSubscribe: 'subscribeControllerV4',
  controllerResync: 'resyncControllerV4',
  controllerUnsubscribe: 'unsubscribeControllerV4',
  conversationSubscribe: 'subscribeConversationV4',
  conversationResync: 'resyncConversationV4',
  conversationUnsubscribe: 'unsubscribeConversationV4',
  conversationRowsRange: 'conversationRowsRangeV4',
  sendCommand: 'sendConversationCommandV4',
  queryCommands: 'queryConversationCommandsV4',
  sessionsIndexSubscribe: 'subscribeSessionsIndexV4',
}

export class RelaySession {
  /**
   * @param {object} options
   * @param {object} options.endpoint 已导入的 zcode-relay 端点
   * @param {(url:string)=>object} options.connect 返回 socket 适配器
   * @param {object} [options.handlers] 状态回调
   */
  constructor({ endpoint, connect, handlers = {}, now = () => Date.now() }) {
    this.endpoint = endpoint
    this.connect = connect
    this.handlers = handlers
    this.now = now

    this.socket = null
    this.state = 'idle'
    this.led = LED_LOADING
    this.bridge = null
    this.channel = null
    this.fragments = new FragmentAssembler()
    /** 分片重组：按 messageSeq 攒裸载荷字节（这里的帧没有 13 字节头）。 */
    this.bridgeParts = new Map()
    this.rpcSeq = 0
    this.requestSeq = 0
    this.pendingRequests = new Map()
    this.closedByUs = false
    this.initialView = null
    this.workspaces = []
    /**
     * 收发日志。诊断"连上了但读不到内容"这类问题时，唯一可靠的办法是看真实帧，
     * 所以这里把每个进出报文都留一份（截断到 MAX_LOG_TEXT）。
     */
    this.log = []
  }

  /** 记一笔诊断日志。方向 `→` 出站、`←` 入站、`·` 状态。 */
  pushLog(direction, text) {
    const body = typeof text === 'string' ? text : String(text ?? '')
    this.log.push({
      at: this.now(),
      direction,
      text: body.length > MAX_LOG_TEXT ? body.slice(0, MAX_LOG_TEXT) + `…(+${body.length - MAX_LOG_TEXT})` : body,
    })
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
  }

  get sid() {
    return this.endpoint?.params?.[SID_KEY] ?? ''
  }

  get passHash() {
    return this.endpoint?.params?.[HASH_KEY] ?? ''
  }

  start() {
    if (this.socket) return
    this.closedByUs = false
    this.setState('connecting')
    const url = relayWsUrl(this.endpoint)
    this.pushLog('·', `connecting ${url}`)
    const socket = this.connect(url)
    this.socket = socket

    socket.onOpen(() => this.sendAuthInit())
    socket.onMessage((data) => this.onSocketMessage(data))
    socket.onError((error) => this.onSocketError(error))
    socket.onClose((event) => this.onSocketClose(event))
  }

  stop() {
    this.closedByUs = true
    this.clearBridgeTimers()
    try {
      this.socket?.close()
    } catch {
      /* 已经关了 */
    }
    this.socket = null
    this.channel?.dispose('会话已停止')
    this.channel = null
    this.bridge = null
    this.bridgeReady = false
    for (const [, waiter] of this.platformPending ?? []) waiter.reject(new Error('会话已停止'))
    this.platformPending?.clear()
    this.setState('idle')
  }

  // -------------------------------------------------------------------------
  // 握手
  // -------------------------------------------------------------------------

  sendAuthInit() {
    this.sendJson({
      type: 'auth_init',
      role: 'terminal',
      device_sid: this.sid,
      meta: {
        platform: 'web',
        version: this.endpoint?.params?.app_version ?? '0.0.0',
        name: 'shou',
      },
      client_ts: this.now(),
    })
  }

  /**
   * proof = base64url(HMAC-SHA256(key=passHash, msg=`${nonce}|terminal|${deviceSid}`))。
   * 三段用 `|` 连接，角色是小写字面量——顺序或大小写错了服务端只会静默拒绝。
   */
  sendAuthResponse(nonce) {
    const message = `${nonce}|terminal|${this.sid}`
    const proof = base64(hmacSha256(utf8(this.passHash), utf8(message)), true)
    this.sendJson({
      type: 'auth_response',
      device_sid: this.sid,
      proof,
      client_ts: this.now(),
    })
  }

  // -------------------------------------------------------------------------
  // 阶段一：JSON 信封
  // -------------------------------------------------------------------------

  nextRequestId(prefix) {
    this.requestSeq += 1
    return `${prefix}-${this.now().toString(36)}-${this.requestSeq}`
  }

  sendEnvelope(payload) {
    this.sendJson({ type: 'data', payload, client_ts: this.now() })
  }

  bootstrap() {
    const requestId = this.nextRequestId('bootstrap')
    this.pendingRequests.set(requestId, 'bootstrap')
    this.sendEnvelope({ zcode_type: 'bootstrap-request', requestId })
    return requestId
  }

  workspaceList() {
    const requestId = this.nextRequestId('workspace-list')
    this.pendingRequests.set(requestId, 'workspace-list')
    this.sendEnvelope({ zcode_type: 'workspace-list-request', requestId })
    return requestId
  }

  platformRequest(method, args = {}) {
    const requestId = this.nextRequestId('platform')
    this.pendingRequests.set(requestId, `platform:${method}`)
    this.sendEnvelope({ zcode_type: 'platform-request', requestId, method, args })
    return requestId
  }

  /**
   * 带返回值的 platform-request。
   *
   * 阶段一的 `platform-request {requestId, method, args}` → `platform-response` 是一层
   * 通用方法代理：如果桌面端在这里就暴露了会话读取，那我们可能根本不需要桥接 RPC。
   * 但可用的方法名没有公开文档，所以做成可由诊断页逐个试探的形式。
   */
  platformCall(method, args = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId('platform')
      if (!this.platformPending) this.platformPending = new Map()
      const timer = setTimeout(() => {
        if (this.platformPending.delete(requestId)) reject(new Error(`platform-request 超时：${method}`))
      }, timeoutMs)
      this.platformPending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.sendEnvelope({ zcode_type: 'platform-request', requestId, method, args })
    })
  }

  /**
   * 打开工作区桥接——阶段二的入口。
   *
   * 这一步的字段是从官方 mobile 前端 bundle（remote/v4 3.14.3）里逐字核对出来的，
   * 之前三个字段都写错了，而桌面端对不合规报文**不报错、直接丢**，所以我们发了三次
   * 一点回应都没有：
   *
   *   1. **`requestId` 是必填**（官方 `requestId: X9('workspace-bridge')`）。我原来根本没带，
   *      报文校验不过 → 被静默丢弃。这是主因。
   *   2. `bridgeGeneration` 是**每次开启递增的计数**（官方 `++u`），不是我原来写死的 0。
   *   3. `recoveryId` **只在续接已有桥接时才带**（官方 `...l ? {recoveryId: l} : {}`）。
   *      我原来每次编一个新 uuid，会被当成"续接一个桌面端不认识的会话"。
   *      现在改为从 `workspace-bridge-ready` 的响应里取回来，供断线续接使用。
   */
  openWorkspaceBridge(workspaceKey, taskId) {
    // 已经在开了（同一个工作区）就直接返回：重复调用会让桌面端收到重复请求，
    // 真机日志里出现过同一毫秒两发——那是任务列表页与会话页各调了一次。
    if (this.bridge && !this.bridgeReady && this.bridge.workspaceKey === workspaceKey) {
      return this.bridge
    }

    this.bridgeGeneration = (this.bridgeGeneration ?? 0) + 1
    this.bridge = {
      bridgeSessionId: randomId(),
      bridgeGeneration: this.bridgeGeneration,
      workspaceKey,
    }
    this.bridgeTaskId = taskId ?? null
    this.bridgeAttempts = 0
    this.sendBridgeOpen()
    return this.bridge
  }

  sendBridgeOpen() {
    if (!this.bridge || this.bridgeReady) return
    // 防抖：重发定时器与重复调用可能撞在一起，没必要连发两条一样的请求。
    if (this.lastBridgeOpenAt && this.now() - this.lastBridgeOpenAt < 500) return
    this.lastBridgeOpenAt = this.now()

    this.bridgeAttempts = (this.bridgeAttempts ?? 0) + 1
    this.pushLog(
      '→',
      `workspace-bridge-open #${this.bridgeAttempts} key=${this.bridge.workspaceKey} task=${this.bridgeTaskId ?? '-'}`,
    )
    this.sendEnvelope({
      zcode_type: 'workspace-bridge-open',
      // 官方必填字段。少了它桌面端会静默丢弃整条报文。
      requestId: this.nextRequestId('workspace-bridge'),
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      workspaceKey: this.bridge.workspaceKey,
      ...(this.bridgeTaskId ? { taskId: this.bridgeTaskId } : {}),
    })

    if (this.bridgeAttempts >= 3) {
      this.pushLog('!', 'bridge-open 发了 3 次都没有回应，改走 platform-request 读会话')
      this.handlers.onBridgeFailed?.('电脑端没有回应打开通道的请求（bridge-open 无响应）')
      return
    }
    this.bridgeRetry = setTimeout(() => {
      this.bridgeRetry = null
      if (!this.bridgeReady) this.sendBridgeOpen()
    }, 4000)
  }

  // -------------------------------------------------------------------------
  // 阶段二：桥接 RPC
  // -------------------------------------------------------------------------

  attachBridge(bridge) {
    this.bridgeReady = true
    this.clearBridgeTimers()
    this.bridge = {
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration ?? this.bridge?.bridgeGeneration ?? 0,
      // recoveryId 由桌面端下发，断线续接时再带回去（官方就是这么用的）。
      recoveryId: bridge.recoveryId,
      workspaceKey: bridge.workspaceKey,
      initialTaskId: bridge.initialTaskId ?? null,
    }
    this.pushLog('·', `bridge ready key=${this.bridge.workspaceKey} task=${this.bridge.initialTaskId ?? '-'}`)
    this.channel = new ChannelClient((payload) => this.sendRpcFrame(payload))
    this.connectionInfo = null
    this.topicListeners = new Map()
    // 订阅 ack 是 Promise 调用；增量帧不带那个请求 id，按 topic 路由。
    this.channel.onUnmatchedEvent = (data) => this.dispatchTopicFrame(data)
    // 握手交给上层（session-manager）：hello → initializeConversationV4，
    // 因为要从 hello 响应里取桌面端分配的 connectionId 并记录日志。
    this.handlers.onBridgeReady?.(this.bridge, this.channel)
  }

  /** 注册一个按 topic 前缀匹配的帧监听（`conversation/<sid>`、`controller/tasks-index`）。 */
  addTopicListener(topic, handler) {
    if (!this.topicListeners) this.topicListeners = new Map()
    if (!this.topicListeners.has(topic)) this.topicListeners.set(topic, new Set())
    this.topicListeners.get(topic).add(handler)
    return () => this.topicListeners.get(topic)?.delete(handler)
  }

  /** 按注册的 topic 前缀分发一帧；controller/* 与 conversation/* 都按前缀匹配。 */
  dispatchTopicFrame(data) {
    const topic = String(data?.topic ?? '')
    if (!topic) return
    for (const [key, handlers] of this.topicListeners ?? []) {
      if (topic === key || topic.startsWith(key + '/') || key.startsWith(topic)) {
        for (const handler of handlers) {
          try {
            handler(data)
          } catch {
            /* 单个监听器的错误不能打断其余路由 */
          }
        }
      }
    }
  }

  clearBridgeTimers() {
    if (this.bridgeRetry) clearTimeout(this.bridgeRetry)
    if (this.reconnectFallback) clearTimeout(this.reconnectFallback)
    this.bridgeRetry = null
    this.reconnectFallback = null
  }

  /**
   * 发一条桥接帧。
   *
   * 元数据字段是**必需的**：真机日志里桌面端发来的每帧都带
   * `fragmentCount` / `fragmentIndex` / `messageBytes` / `checksum{crc32}`，
   * 而我们的帧一个都没有，于是桌面端在收到我们第一个请求后立刻判定
   * `bridge-degraded: rpc-transport-fault` 并停发。
   */
  sendRpcFrame(payload) {
    if (!this.bridge) return
    this.rpcSeq += 1
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
    this.sendEnvelope({
      zcode_type: 'rpc-frame',
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      ...(this.bridge.recoveryId ? { recoveryId: this.bridge.recoveryId } : {}),
      seq: this.rpcSeq,
      messageSeq: this.rpcSeq,
      fragmentCount: 1,
      fragmentIndex: 0,
      messageBytes: bytes.length,
      checksum: { algorithm: 'crc32', value: crc32Hex(bytes) },
      dataBase64: base64(bytes),
    })
  }

  /** 按字节拼分片。载荷是二进制的，不能像文本帧那样拼字符串（会把多字节序列切坏）。 */
  assembleFragments(payload, index, total, part) {
    const key = String(payload.messageSeq ?? `${payload.bridgeGeneration ?? 0}:${index}`)
    let slot = this.bridgeParts.get(key)
    if (!slot) {
      slot = { parts: new Map(), count: total }
      this.bridgeParts.set(key, slot)
      // 上限保护：真机上出过 `rpc-transport-fault`，不明来源的分片不能无限攒。
      if (this.bridgeParts.size > 16) this.bridgeParts.delete(this.bridgeParts.keys().next().value)
    }
    if (slot.parts.has(index)) return null
    try {
      slot.parts.set(index, base64Decode(part))
    } catch {
      this.bridgeParts.delete(key)
      return null
    }
    if (slot.parts.size < total) return null

    let length = 0
    for (const chunk of slot.parts.values()) length += chunk.length
    const joined = new Uint8Array(length)
    let offset = 0
    for (let i = 0; i < total; i++) {
      const chunk = slot.parts.get(i)
      if (!chunk) return null
      joined.set(chunk, offset)
      offset += chunk.length
    }
    this.bridgeParts.delete(key)
    return joined
  }

  /** 收到 bridge-degraded：桌面端已经判定这条桥接不可用，如实报出来而不是继续干等。 */
  onBridgeDegraded(reason) {
    this.pushLog('!', `bridge-degraded: ${reason}`)
    this.bridgeReady = false
    this.handlers.onBridgeFailed?.(`电脑端判定桥接故障：${reason}`)
  }

  ackRpcFrame(ackMessageSeq) {
    this.sendEnvelope({
      zcode_type: 'rpc-frame-ack',
      ackMessageSeq,
      bridgeSessionId: this.bridge?.bridgeSessionId,
      bridgeGeneration: this.bridge?.bridgeGeneration,
      recoveryId: this.bridge?.recoveryId,
    })
  }

  // -------------------------------------------------------------------------
  // 传输
  // -------------------------------------------------------------------------

  sendJson(message) {
    const text = JSON.stringify(message)
    this.pushLog('→', summarizeOutbound(message, text))
    try {
      this.socket?.send(text)
    } catch {
      /* 发送失败由 close 事件兜底 */
    }
  }

  onSocketMessage(data) {
    const text = typeof data === 'string' ? data : utf8DecodeBytes(data)
    this.pushLog('←', text)
    const root = parseFrameText(text)
    if (!root) return
    this.handleRoot(root)
  }

  handleRoot(root) {
    const nextLed = onFrameRoot(root)
    if (nextLed) this.setLed(nextLed)

    const payload = root.payload ?? root

    // 桌面端判定桥接不可用（真机上出现过 reason: rpc-transport-fault——那正是收不到 ACK 的后果）
    if (payload?.zcode_type === 'bridge-degraded') {
      this.onBridgeDegraded(payload.reason ?? 'unknown')
      return
    }

    // 阶段二：桥接 RPC 帧
    if (payload?.zcode_type === 'rpc-frame') {
      this.handleRpcFrame(payload)
      return
    }

    // 握手阶段
    if (root.type === 'auth_challenge') {
      this.setState('auth_challenge')
      this.sendAuthResponse(root.nonce)
      return
    }
    if (root.type === 'auth_ack' || root.type === 'pair_status_ack') {
      this.setState(root.pair_status === 'matched' ? 'paired' : 'waiting')
      this.pushLog('·', `pair_status=${root.pair_status ?? 'unknown'}`)
      this.handlers.onPairStatus?.(root.pair_status ?? 'unknown')
      if (root.pair_status === 'matched') this.bootstrap()
      return
    }
    if (root.type === 'error') {
      this.pushLog('!', `error code=${root.code ?? ''} message=${root.message ?? ''}`)
      this.handlers.onError?.({
        code: root.code ?? '',
        message: root.message ?? '',
        terminal: nextLed === LED_ERROR,
      })
      return
    }

    // 分片
    if (payload?.kind === 'fragment') {
      const assembled = this.fragments.accept({
        logicalFrameId: payload.logicalFrameId,
        fragmentIndex: payload.fragmentIndex,
        fragmentCount: payload.fragmentCount,
        dataBase64: payload.dataBase64,
      })
      if (assembled) {
        const inner = parseFrameText(assembled)
        if (inner) this.handleRoot(inner)
      }
      return
    }
    if (payload?.kind === 'binary' && payload.dataBase64) {
      const inner = parseFrameText(utf8DecodeBytes(base64Decode(payload.dataBase64)))
      if (inner) this.handleRoot(inner)
      return
    }

    // 信封
    const envelope = findEnvelope(root)
    if (envelope) this.handleEnvelope(envelope, root)

    // 主题帧（sessions-index / controller/tasks-index）
    const topicFrame = findTopicFrame(root)
    if (topicFrame) this.handleTopicFrame(topicFrame)
  }

  handleEnvelope(envelope, root) {
    const kind = envelope.zcode_type
    const requestId = envelope.requestId ?? ''

    if (kind === 'bootstrap-response') {
      const result = envelope.result ?? {}
      this.initialView = result.initialViewState ?? null
      const tasks = parseFlatTasks(result)
      this.pushLog('·', `bootstrap: tasks=${tasks.length} activeWorkspace=${this.initialView?.activeWorkspaceKey ?? '-'}`)
      this.handlers.onTasks?.({ tasks, replace: true })
      this.handlers.onInitialView?.(this.initialView)
      this.workspaceList()
      return
    }

    if (kind === 'workspace-list-response') {
      const result = envelope.result ?? {}
      this.workspaces = parseWorkspaces(result)
      const tasks = parseFlatTasks(result)
      this.pushLog('·', `workspace-list: workspaces=${this.workspaces.length} tasks=${tasks.length}`)
      if (this.workspaces.length) {
        // 把第一条的原始结构记下来：字段名没有公开文档，这是确认它的唯一可靠办法。
        this.pushLog('·', `workspaces[0]=${JSON.stringify(this.workspaces[0].raw).slice(0, 400)}`)
      }
      if (tasks.length) this.handlers.onTasks?.({ tasks, replace: false })
      this.handlers.onWorkspaces?.(this.workspaces)
      return
    }

    if (kind === 'platform-response') {
      const pending = this.pendingRequests.get(requestId)
      this.pendingRequests.delete(requestId)
      const summary = `platform ${envelope.method ?? pending ?? ''} success=${envelope.success !== false}`
      this.pushLog('·', summary)
      const waiter = this.platformPending?.get(requestId)
      if (waiter) {
        this.platformPending.delete(requestId)
        waiter.resolve(envelope)
      }
      this.handlers.onPlatformResponse?.({
        method: envelope.method ?? pending ?? '',
        success: envelope.success !== false,
        result: envelope.result,
        error: envelope.error,
      })
      return
    }

    // 我们不再发 workspace-reconnect（那条请求是给 ssh/wsl/docker 远程工作区用的），
    // 但真机上它确实出现过，留着这条日志以免将来看到无解释的帧。
    if (kind === 'workspace-reconnect-response') {
      this.pushLog('!', `收到未被请求的 workspace-reconnect-response：${envelope.error ?? ''}`)
      return
    }

    if (kind === 'workspace-bridge-ready') {
      const bridge = envelope.bridge ?? envelope
      if (bridge?.bridgeSessionId) this.attachBridge(bridge)
      else this.pushLog('!', `workspace-bridge-ready 缺少 bridgeSessionId：${JSON.stringify(envelope).slice(0, 200)}`)
      return
    }

    if (kind === 'mobile-view-state') {
      this.handlers.onViewState?.(envelope)
      return
    }

    // 其余信封交给上层（例如桌面端主动推的状态更新）
    this.handlers.onEnvelope?.(envelope, root)
  }

  handleTopicFrame(frame) {
    const topic = String(frame.topic ?? '')
    const payload = frame.payload ?? frame.frame?.payload ?? {}
    if (topic.startsWith('sessions-index')) {
      const { upserts, removes } = parseSessionDeltas(payload, topic)
      if (upserts.length) this.handlers.onSessions?.({ upserts })
      if (removes.length) this.handlers.onSessionsRemoved?.(removes)
      return
    }
    if (topic === 'controller/tasks-index') {
      if (isBootstrapResult(frame.logicalFrameId)) {
        const { upserts } = parseTaskDeltas(payload)
        this.handlers.onTasks?.({ tasks: upserts, replace: true, preservePinned: true })
        return
      }
      const { upserts, removes, archived } = parseTaskDeltas(payload)
      if (upserts.length) this.handlers.onTasks?.({ tasks: upserts, replace: false })
      if (removes.length) this.handlers.onSessionsRemoved?.(removes)
      if (archived.length) this.handlers.onArchived?.(archived)
      return
    }
    this.handlers.onTopicFrame?.(frame)
  }

  /**
   * 处理一条入站的桥接帧。
   *
   * 两个从真机日志里定死的约定，之前都搞错了：
   *
   * 1. **`dataBase64` 里是裸的 channel 载荷，没有 13 字节帧头。**
   *    帧头是 CLI/NDJSON 那条传输用的；走中继时，头部字段被搬进了 JSON 信封
   *    （`seq` / `messageSeq` / `messageBytes` / `checksum` / `fragmentIndex`）。
   *    我原先用 FrameReader 去读前 13 字节，读到的全是垃圾，于是桌面端反复发来的
   *    `Initialize`（`BAIGyAEA` = serialize([200]) + serialize(undefined)）**一次都没被认出来**。
   *
   * 2. **每一帧都必须回 ACK**（`rpc-frame-ack {ackMessageSeq}`）。桌面端收不到就每 5–10 秒
   *    重发同一帧，最后判定 `bridge-degraded: rpc-transport-fault` 并停止发送——
   *    这正是之前一直看不懂的那个故障名。
   */
  handleRpcFrame(payload) {
    // 先 ACK：不 ACK 的话后面做什么都没意义。
    if (payload.messageSeq !== undefined) this.ackRpcFrame(payload.messageSeq)

    if (payload.zcode_type === 'bridge-degraded') return

    const part = payload.dataBase64
    if (typeof part !== 'string' || !part) return

    // 分片：单帧直接解；多帧按 logicalFrameId 攒齐（这里的帧没有 13 字节头，
    // 分片信息同样在 JSON 里，所以拼的是 channel 载荷本身）。
    const total = Number(payload.fragmentCount ?? 1)
    const index = Number(payload.fragmentIndex ?? 0)
    let bytes
    if (total > 1) {
      bytes = this.assembleFragments(payload, index, total, part)
      if (bytes === null) return
    } else {
      try {
        bytes = base64Decode(part)
      } catch {
        this.pushLog('!', 'rpc-frame 的 dataBase64 解不开')
        return
      }
    }

    try {
      const decoded = decodeResponse(bytes)
      this.pushLog('·', `rpc response type=${decoded.type} id=${decoded.id}`)
      this.channel?.handleResponse(decoded)
    } catch (error) {
      this.pushLog('!', `rpc decode failed: ${error?.message ?? error}`)
      this.handlers.onError?.({ code: 'RPC_DECODE', message: String(error?.message ?? error) })
    }
  }

  sendFrame(type, id, ack) {
    if (!this.bridge) return
    this.rpcSeq += 1
    const bytes = writeFrame({ type, id: id ?? this.rpcSeq, ack: ack ?? 0, data: new Uint8Array(0) })
    this.sendEnvelope({
      zcode_type: 'rpc-frame',
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      recoveryId: this.bridge.recoveryId,
      seq: this.rpcSeq,
      dataBase64: base64(bytes),
    })
  }

  onSocketError(error) {
    this.handlers.onError?.({ code: 'SOCKET', message: String(error?.errMsg ?? error?.message ?? error) })
  }

  onSocketClose(event) {
    const reason = String(event?.reason ?? '')
    const code = Number(event?.code ?? 0)
    this.channel?.dispose(`连接已关闭：${reason || '未知原因'}`)
    this.channel = null
    this.bridge = null
    this.bridgeReady = false
    if (this.closedByUs) return
    this.setState('closed')
    // 四种关闭的处置方式完全不同，必须分开——见 relay-led 的 classifyClose。
    // 早先这里把它们混成一个"终态"，于是"另一个客户端占着设备"被报成「配对已失效」，
    // 而用户的链接其实完全没问题。
    const kind = classifyClose(code, reason)
    this.pushLog('·', `socket closed code=${code} reason=${reason || '-'} kind=${kind}`)
    this.handlers.onClosed?.({ code, reason, kind, terminal: kind === CLOSE_REPAIR })
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.pushLog('·', `state=${state}`)
    this.handlers.onState?.(state)
  }

  setLed(led) {
    if (this.led === led) return
    this.led = led
    this.handlers.onLed?.(led)
  }

  /** 当前使用的链接（带重铸的 t），界面上的「刷新」按钮就是重新取它。 */
  currentUrl() {
    return buildPairingUrl(this.endpoint, this.now())
  }
}

/** UUID v4。桥接身份用官方同款形态——用自定义字符串有被桌面端校验拒掉的风险。 */
function randomId() {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 出站报文的日志文本。
 *
 * 桥接帧的 `dataBase64` 是二进制载荷，整段打进日志既看不懂又会把内存吃光，
 * 所以换成"长度 + 前 120 字符"的摘要——排错时要的是"发了什么、多大"，不是原文。
 */
function summarizeOutbound(message, text) {
  const payload = message?.payload
  if (payload?.zcode_type === 'rpc-frame' && typeof payload.dataBase64 === 'string') {
    const head = payload.dataBase64.slice(0, 120)
    return JSON.stringify({
      ...message,
      payload: { ...payload, dataBase64: `<${payload.dataBase64.length}B> ${head}…` },
    })
  }
  return text
}

function utf8DecodeBytes(bytes) {
  if (typeof bytes === 'string') return bytes
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i++]
    if (byte < 0x80) out += String.fromCharCode(byte)
    else if (byte < 0xe0) out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i++] & 0x3f))
    else if (byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      )
    } else {
      const code =
        ((byte & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
      const v = code - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
  }
  return out
}

/**
 * uni 的 WebSocket 适配器。
 *
 * 注意 uni 的 socket 在 App 端拿到的是 ArrayBuffer（二进制帧），要显式声明
 * 需要字符串：`uni.connectSocket` 没有直接的选项，因此在 onMessage 里同时兼容两种形态。
 */
export function uniConnect(url) {
  const task = uni.connectSocket({ url, complete: () => {} })
  const state = { open: null, message: null, error: null, close: null }
  task.onOpen((event) => state.open?.(event))
  task.onMessage((event) => state.message?.(event.data))
  task.onError((event) => state.error?.(event))
  task.onClose((event) => state.close?.(event))
  return {
    send: (text) => task.send({ data: text }),
    close: () => task.close({ code: 1000 }),
    onOpen: (fn) => (state.open = fn),
    onMessage: (fn) => (state.message = fn),
    onError: (fn) => (state.error = fn),
    onClose: (fn) => (state.close = fn),
  }
}
