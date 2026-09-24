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
import { FrameReader, ProtocolMessageType, ChannelClient, decodeResponse, writeFrame } from '../core/rpc-wire.js'
import { LED_ERROR, LED_LIVE, LED_LOADING, isTerminalClose, onFrameRoot } from '../core/relay-led.js'
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

/** v4 方法名（OSS `packages/shared/src/zcode-protocol-v4/transport.ts`）。 */
export const V4 = {
  controllerSubscribe: 'v4/controller/subscribe',
  controllerUnsubscribe: 'v4/controller/unsubscribe',
  conversationSubscribe: 'v4/conversation/subscribe',
  conversationRowsRange: 'v4/conversation/rowsRange',
  command: 'v4/command',
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
    this.frameReader = new FrameReader()
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

  /**
   * clientHello。
   *
   * OSS 的注释说 subscribe 的 `clientMode`「由可信 host 从该连接的 clientHello 注入」，
   * 而 `clientKind: "mobileRemote"` 正是官方移动端的取值——所以这一步可能是订阅被接受的前提。
   * 早期笔记记录过它没有响应，无响应不影响连接，但发了才能让 host 认出来我们是谁。
   */
  sendClientHello() {
    this.sendEnvelope({
      kind: 'clientHello',
      protocolVersion: 3,
      clientId: this.bridge?.bridgeSessionId ?? this.sid,
      clientKind: 'mobileRemote',
      appVersion: this.endpoint?.params?.app_version ?? '0.0.0',
    })
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
   * **不再先发 `workspace-reconnect-request`。** 真机上那条请求被电脑端明确拒绝：
   * 「远程 workspace 不在当前窗口中，无法重连」。查过 OSS 才确认原因：
   * ZCode 里"远程 workspace"指的是跑在 **ssh / wsl / docker** 上的工作区
   * （`remote-workspace-identity.ts` 的 `RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker"`），
   * 跟手机远控是两回事——拿一个本地路径去问它，注定被拒。那是我上一轮的错误假设。
   *
   * 现在直接发 bridge-open，并且会重发几次：真机上它**完全没有回应**（既不是拒绝也不是接受），
   * 所以用重发来区分"没收到"和"不认识"。
   */
  openWorkspaceBridge(workspaceKey, taskId) {
    // 已经在开了（同一个工作区）就直接返回：重复调用会让桌面端收到重复请求，
    // 真机日志里出现过同一毫秒两发——那是任务列表页与会话页各调了一次。
    if (this.bridge && !this.bridgeReady && this.bridge.workspaceKey === workspaceKey) {
      return this.bridge
    }

    this.bridge = {
      bridgeSessionId: randomId(),
      bridgeGeneration: 0,
      recoveryId: randomId(),
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
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      recoveryId: this.bridge.recoveryId,
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
      bridgeGeneration: bridge.bridgeGeneration ?? 0,
      recoveryId: bridge.recoveryId,
      workspaceKey: bridge.workspaceKey,
      initialTaskId: bridge.initialTaskId ?? null,
    }
    this.pushLog('·', `bridge ready key=${this.bridge.workspaceKey} task=${this.bridge.initialTaskId ?? '-'}`)
    this.channel = new ChannelClient((payload) => this.sendRpcFrame(payload))
    // 桥接就是这条下游连接，先自报家门，再让订阅走 host 的 clientMode 注入。
    this.sendClientHello()
    this.handlers.onBridgeReady?.(this.bridge, this.channel)
  }

  clearBridgeTimers() {
    if (this.bridgeRetry) clearTimeout(this.bridgeRetry)
    if (this.reconnectFallback) clearTimeout(this.reconnectFallback)
    this.bridgeRetry = null
    this.reconnectFallback = null
  }

  sendRpcFrame(payload) {
    if (!this.bridge) return
    this.rpcSeq += 1
    this.sendEnvelope({
      zcode_type: 'rpc-frame',
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      recoveryId: this.bridge.recoveryId,
      seq: this.rpcSeq,
      dataBase64: base64(payload),
    })
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

  handleRpcFrame(payload) {
    if (payload.ackMessageSeq !== undefined) this.ackRpcFrame(payload.ackMessageSeq)
    if (!payload.dataBase64) return
    let bytes
    try {
      bytes = base64Decode(payload.dataBase64)
    } catch {
      return
    }
    this.frameReader.acceptChunk(bytes)
    for (const frame of this.frameReader.readFrames()) {
      switch (frame.type) {
        case ProtocolMessageType.Regular: {
          try {
            const decoded = decodeResponse(frame.data)
            this.pushLog('·', `rpc response type=${decoded.type} id=${decoded.id}`)
            this.channel?.handleResponse(decoded)
          } catch (error) {
            this.pushLog('!', `rpc decode failed: ${error?.message ?? error}`)
            this.handlers.onError?.({ code: 'RPC_DECODE', message: String(error?.message ?? error) })
          }
          break
        }
        case ProtocolMessageType.KeepAlive:
          // 用"最后收到的 id"回 ACK，而不是回自己的计数——官方就是这么做的。
          this.sendFrame(ProtocolMessageType.Ack, frame.id, frame.id)
          break
        default:
          break
      }
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
    // 终态判定必须用官方关闭码与九条文本原因。
    // 早先这里是 `onFrameRoot({type:'error', code: reason})`——把**关闭原因字符串**当成
    // 错误码去比，任何一次关闭（reason 甚至可能是空串）都会落进"未知错误码"分支从而被判成
    // 终态，界面于是显示「配对已失效」。网络一抖就"失效"就是这么来的。
    const terminal = isTerminalClose(code, reason)
    this.pushLog('·', `socket closed code=${code} reason=${reason || '-'} terminal=${terminal}`)
    this.handlers.onClosed?.({ code, reason, terminal })
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
