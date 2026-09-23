import { createHmac, randomUUID } from 'node:crypto'
import { info, warn } from '../../log.ts'
import {
  RPC_CHANNEL_ZCODE_AGENT,
  RpcRequestType,
  RpcResponseType,
  deserializeValue,
  frameRpc,
  parseRpcFrames,
  serializeValue,
} from './rpc-codec.ts'

/**
 * 官方中继客户端（协议细节见 docs/relay-protocol.md，均经 bundle 逆向 + 实测验证）。
 * 层次：relay JSON 帧（auth/data）→ rpc-frame 信封（seq/ack/bridge identity）→
 *       dataBase64 内层 = 13 字节 VSCode 帧头 + NDJSON（v4 消息）。
 */

export const RELAY_HOSTS = new Set(['zcode.z.ai', 'zcode.chatglm.site'])

export interface RelayPairing {
  wsUrl: string
  deviceSid: string
  passHash: string
  timestamp: number
  deviceMid?: string
  deviceName?: string
  appVersion?: string
}

export function parsePairingUrl(urlStr: string): RelayPairing | null {
  let u: URL
  try {
    u = new URL(urlStr.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !RELAY_HOSTS.has(u.hostname)) return null
  const deviceSid = u.searchParams.get('sid') ?? ''
  const passHash = u.searchParams.get('hash') ?? ''
  const timestamp = Number(u.searchParams.get('t') ?? NaN)
  if (!deviceSid || !passHash || !Number.isFinite(timestamp)) return null
  return {
    wsUrl: `wss://${u.hostname}/ws`,
    deviceSid,
    passHash,
    timestamp,
    deviceMid: u.searchParams.get('mid') ?? undefined,
    deviceName: u.searchParams.get('name') ?? undefined,
    appVersion: u.searchParams.get('app_version') ?? undefined,
  }
}

export type PairStatus = 'waiting' | 'matched' | 'closed'
export type RelayState = 'idle' | 'authenticating' | 'waiting' | 'matched' | 'closed'

export interface RelayEvents {
  onState?(state: RelayState, detail?: string): void
  /** 内层 v4 原始 NDJSON 消息（已解出 rpc-frame） */
  onV4Message?(msg: Record<string, unknown>): void
  onFault?(code: string, message: string): void
  /** 内层裸 JSON 信封（bootstrap/platform 等，非 rpc-frame 路径） */
  onInnerJson?(frame: Record<string, unknown>): void
  /** bootstrap-response 到达（数据面通道就绪的标志） */
  onBootstrap?(frame: Record<string, unknown>): void
}

// ---------- 内层编码 ----------

const HEADER_SIZE = 13

/** 13 字节 VSCode 帧（type=Regular, id, ack, length）+ payload */
function channelFrame(payload: string, msgId: number, ack: number): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const buf = Buffer.alloc(HEADER_SIZE + body.length)
  buf.writeUInt8(1, 0)
  buf.writeUInt32BE(msgId >>> 0, 1)
  buf.writeUInt32BE(ack >>> 0, 5)
  buf.writeUInt32BE(body.length, 9)
  body.copy(buf, HEADER_SIZE)
  return buf
}

/** 解 13 字节帧；返回 null 表示字节不足/不合法 */
function channelFrames(data: Buffer): { id: number; ack: number; payload: string }[] {
  const out: { id: number; ack: number; payload: string }[] = []
  let off = 0
  while (off + HEADER_SIZE <= data.length) {
    const type = data.readUInt8(off)
    const id = data.readUInt32BE(off + 1)
    const ack = data.readUInt32BE(off + 5)
    const len = data.readUInt32BE(off + 9)
    if (type !== 1 || off + HEADER_SIZE + len > data.length) {
      if (len > 8 * 1024 * 1024) return out // 异常长度，丢弃
      return out
    }
    out.push({ id, ack, payload: data.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len).toString('utf8') })
    off += HEADER_SIZE + len
  }
  return out
}

interface BridgeIdentity {
  bridgeSessionId: string
  bridgeGeneration: number
  recoveryId: string
}

export class RelayClient {
  #pairing: RelayPairing
  #events: RelayEvents
  #ws: WebSocket | null = null
  #state: RelayState = 'idle'
  #seq = 0
  #ackSeq = 0
  #identity: BridgeIdentity
  #msgId = 0
  #closedByUs = false
  #v4Mode: 'ndjson' | 'channel-frame' = 'ndjson' // 内层编码实证开关
  #probeCount = 0
  #reconnectAttempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(pairing: RelayPairing, events: RelayEvents = {}) {
    this.#pairing = pairing
    this.#events = events
    this.#identity = {
      bridgeSessionId: randomUUID(),
      bridgeGeneration: 0,
      recoveryId: randomUUID(),
    }
  }

  get state(): RelayState {
    return this.#state
  }

  get pairing(): RelayPairing {
    return this.#pairing
  }

  #setState(s: RelayState, detail?: string): void {
    this.#state = s
    this.#events.onState?.(s, detail)
  }

  connect(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#closedByUs = false
    this.#setState('authenticating')
    const ws = new WebSocket(this.#pairing.wsUrl)
    this.#ws = ws
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'auth_init',
        role: 'terminal',
        device_sid: this.#pairing.deviceSid,
        meta: { platform: 'web', version: this.#pairing.appVersion ?? 'web', name: 'mobile-browser' },
        client_ts: Date.now(),
      }))
    })
    ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)))
    ws.addEventListener('close', (ev) => {
      const code = (ev as CloseEvent).code
      this.#ws = null
      this.#setState('closed', `code=${code} reason=${(ev as CloseEvent).reason || '-'}`)
      this.#events.onFault?.(`close-${code}`, (ev as CloseEvent).reason || 'relay closed')
      // 桌面端中继腿随「远程控制」激活状态浮动：自动重连等待其回归
      if (!this.#closedByUs) {
        this.#reconnectAttempts += 1
        const delay = Math.min(5000 * this.#reconnectAttempts, 60_000)
        this.#reconnectTimer = setTimeout(() => this.connect(), delay)
        warn(`[relay] ${Math.round(delay / 1000)}s 后自动重连（第 ${this.#reconnectAttempts} 次）`)
      }
    })
    ws.addEventListener('error', () => {
      // close 事件随后到达
    })
  }

  close(): void {
    this.#closedByUs = true
    this.#ws?.close()
    this.#ws = null
    this.#setState('closed', 'by-user')
  }

  sendRaw(obj: unknown): void {
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(JSON.stringify(obj))
  }

  async #onMessage(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(frame.type ?? '')
    switch (type) {
      case 'auth_challenge': {
        const nonce = String(frame.nonce ?? '')
        this.sendRaw({
          type: 'auth_response',
          device_sid: this.#pairing.deviceSid,
          proof: b64url(createHmac('sha256', this.#pairing.passHash).update(`${nonce}|terminal|${this.#pairing.deviceSid}`).digest()),
          client_ts: Date.now(),
        })
        return
      }
      case 'auth_ack':
      case 'pair_status_ack': {
        const status = String(frame.pair_status ?? '')
        this.#reconnectAttempts = 0
        if (status === 'matched') {
          this.#setState('matched')
          // 阶段一握手（bootstrap → workspace-list → bridge-open）由适配器驱动；
          // v4 clientHello 在桥接就绪后由适配器调用 sendV4Hello()
        } else {
          this.#setState('waiting', status)
        }
        return
      }
      case 'data': {
        this.#onData(frame.payload)
        return
      }
      case 'error': {
        this.#events.onFault?.(String(frame.code ?? ''), String(frame.message ?? ''))
        return
      }
      default: {
        // 配对成功后的内层 JSON 信封（bootstrap/platform/response 等，官方 mobile 前端行为）
        const zt = typeof frame.zcode_type === 'string' ? frame.zcode_type : ''
        if (zt) this.#onInnerJson(frame)
        return
      }
    }
  }

  #onInnerJson(frame: Record<string, unknown>): void {
    const zt = String(frame.zcode_type)
    // 阶段一通道的响应分发（按 requestId）
    const reqId = String(frame.requestId ?? '')
    if (reqId && this.#pendingJson.has(reqId)) {
      const cb = this.#pendingJson.get(reqId)!
      this.#pendingJson.delete(reqId)
      info(`[relay][v4] ← ${zt}（reqId=${reqId}）`)
      cb(frame)
      return
    }
    if (zt === 'bootstrap-response') {
      const reqId = String(frame.requestId ?? '')
      if (reqId === this.#bootstrapReqId) {
        this.#bootstrapDone = true
        info(`[relay][v4] bootstrap-response 到达，内层=裸 JSON 信封 ✅ ${JSON.stringify(frame).slice(0, 300)}`)
        this.#events.onBootstrap?.(frame)
      }
      return
    }
    this.#events.onInnerJson?.(frame)
  }

  #bootstrapReqId = ''
  #bootstrapDone = false

  /** 阶段一：workspace-list-request → workspace-list-response（桌面端工作区列表） */
  requestWorkspaceList(timeoutMs = 20_000): Promise<Record<string, unknown> | null> {
    return this.#jsonExchange('workspace-list-request', {}, 'workspace-list-response', timeoutMs)
  }

  /** 阶段一：workspace-bridge-open → workspace-bridge-ready（桥接身份，阶段二 RPC 的入口） */
  openBridge(workspaceKey: string, taskId?: string, timeoutMs = 30_000): Promise<Record<string, unknown> | null> {
    const bridgeSessionId = randomUUID()
    return this.#jsonExchange(
      'workspace-bridge-open',
      { bridgeSessionId, bridgeGeneration: 1, workspaceKey, ...(taskId ? { taskId } : {}) },
      'workspace-bridge-ready',
      timeoutMs,
      (frame) => String((frame as Record<string, unknown>).bridgeSessionId ?? '') === bridgeSessionId,
    )
  }

  /** 通用 JSON 信封请求（阶段一通道：request/response 成对，按 requestId 匹配） */
  #pendingJson = new Map<string, (frame: Record<string, unknown>) => void>()

  #jsonExchange(
    requestType: string,
    extra: Record<string, unknown>,
    responseType: string,
    timeoutMs: number,
    match?: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      if (!this.#ws || this.#state !== 'matched') {
        resolve(null)
        return
      }
      const requestId = randomUUID().slice(0, 12)
      const timer = setTimeout(() => {
        this.#pendingJson.delete(requestId)
        warn(`[relay][v4] ${requestType} 超时（${timeoutMs / 1000}s）`)
        resolve(null)
      }, timeoutMs)
      this.#pendingJson.set(requestId, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.sendRaw({
        type: 'data',
        payload: { zcode_type: requestType, requestId, ...extra },
        client_ts: Date.now(),
      })
      info(`[relay][v4] → ${requestType}（reqId=${requestId}）`)
      void match
    })
  }

  /** 配对成功后向桌面端请求 bootstrap（官方 mobile 前端的第一条内层消息） */
  requestBootstrap(timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      if (!this.#ws || this.#state !== 'matched') {
        resolve(null)
        return
      }
      this.#bootstrapReqId = randomUUID().slice(0, 12)
      this.#bootstrapDone = false
      const timer = setTimeout(() => {
        if (!this.#bootstrapDone) {
          warn('[relay][v4] bootstrap 超时（15s）——内层可能不是裸 JSON 信封，将转 13 字节帧头模式')
          resolve(null)
        }
      }, timeoutMs)
      this.#events.onBootstrap = (frame) => {
        clearTimeout(timer)
        resolve(frame)
      }
      // bootstrap 走 data.payload 的内层 JSON 形态（裸发顶层帧会被中继拒绝 WRONG_PARAM）
      this.sendRaw({
        type: 'data',
        payload: { zcode_type: 'bootstrap-request', requestId: this.#bootstrapReqId },
        client_ts: Date.now(),
      })
      info(`[relay][v4] → bootstrap-request（reqId=${this.#bootstrapReqId}）`)
    })
  }

  #onData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    // data.payload 的两种形态：rpc-frame（二进制内层）或内层 JSON 信封（bootstrap 等）
    if (p.zcode_type !== 'rpc-frame') {
      const zt = typeof p.zcode_type === 'string' ? p.zcode_type : ''
      if (zt) this.#onInnerJson(p)
      return
    }
    const seq = Number(p.seq ?? 0)
    // 入站确认
    this.sendRaw({
      type: 'data',
      payload: { zcode_type: 'rpc-frame-ack', ...this.#identity, ackMessageSeq: seq },
      client_ts: Date.now(),
    })
    const dataB64 = String(p.dataBase64 ?? '')
    let bytes: Buffer
    try {
      bytes = Buffer.from(dataB64, 'base64')
    } catch {
      return
    }
    // 阶段二：优先按 13 字节帧 + channel 序列化解析（桥接内 RPC）
    const frames = parseRpcFrames(bytes)
    if (frames.length) {
      for (const f of frames) {
        this.#ackSeq = f.ack || this.#ackSeq
        this.#dispatchChannelBody(f.body)
      }
      return
    }
    // 兼容：旧的 NDJSON 路径（帧头缺失时）
    for (const line of bytes.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.#events.onV4Message?.(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        warn('[relay] v4 消息解析失败', trimmed.slice(0, 160))
      }
    }
  }

  /** 发送 v4 消息：先裸 NDJSON，若 8 秒无响应则改试 13 字节帧头包裹 */
  sendV4Hello(): void {
    const hello = {
      kind: 'clientHello',
      protocolVersion: 3,
      clientId: randomUUID(),
      clientKind: 'mobileRemote',
      appVersion: this.#pairing.appVersion ?? 'web',
      capabilities: { workspaceHookReviewUi: true },
    }
    this.#sendInner(JSON.stringify(hello) + '\n')
    this.#probeCount += 1
    setTimeout(() => {
      if (this.#state !== 'matched' || this.#probeCount !== 1) return
      warn('[relay] 裸 NDJSON 无响应，改用 13 字节帧头包裹重试')
      this.#v4Mode = 'channel-frame'
      this.#sendInner(JSON.stringify(hello) + '\n')
      this.#probeCount += 1
    }, 8000)
  }

  #sendInner(payloadStr: string): void {
    const inner = this.#v4Mode === 'channel-frame'
      ? channelFrame(payloadStr, ++this.#msgId, this.#ackSeq)
      : Buffer.from(payloadStr, 'utf8')
    this.#seq += 1
    this.sendRaw({
      type: 'data',
      payload: {
        zcode_type: 'rpc-frame',
        ...this.#identity,
        seq: this.#seq,
        dataBase64: inner.toString('base64'),
      },
      client_ts: Date.now(),
    })
  }

  /** 供适配器后续使用的 v4 发送入口（先按当前实证模式封装） */
  sendV4(obj: Record<string, unknown>): void {
    this.#sendInner(JSON.stringify(obj) + '\n')
  }

  // ---------- 阶段二：桥接内 channel RPC（13 字节帧 + channel 序列化） ----------

  #rpcSeq = 0
  #rpcPending = new Map<number, (r: { ok: boolean; body?: unknown; error?: string }) => void>()

  /** 桥接内 RPC 调用：serialize([Promise, id, channel, method]) + serialize(arg) */
  rpcCall(method: string, arg?: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#state !== 'matched') {
        reject(new Error('中继未配对'))
        return
      }
      const id = ++this.#rpcSeq
      const timer = setTimeout(() => {
        this.#rpcPending.delete(id)
        reject(new Error(`RPC 超时：${method}`))
      }, timeoutMs)
      this.#rpcPending.set(id, (r) => {
        clearTimeout(timer)
        if (r.ok) resolve(r.body)
        else reject(new Error(r.error ?? 'RPC 失败'))
      })
      const header = serializeValue([RpcRequestType.Promise, id, RPC_CHANNEL_ZCODE_AGENT, method])
      const payload = serializeValue(arg)
      const frame = frameRpc(header, payload, id, this.#ackSeq)
      this.#v4Mode = 'channel-frame'
      this.#sendBinaryFrame(frame)
      info(`[relay][rpc] → ${method}（id=${id}，${frame.length}B）`)
    })
  }

  /** 把二进制帧包进 rpc-frame data 发送 */
  #sendBinaryFrame(frame: Buffer): void {
    this.#seq += 1
    this.sendRaw({
      type: 'data',
      payload: {
        zcode_type: 'rpc-frame',
        ...this.#identity,
        seq: this.#seq,
        dataBase64: frame.toString('base64'),
      },
      client_ts: Date.now(),
    })
  }

  /** 解析入站 channel 帧：PromiseSuccess/PromiseError → 兑现；EventFire → 事件 */
  #dispatchChannelBody(body: Buffer): void {
    try {
      const head = deserializeValue(body)
      const arr = Array.isArray(head.value) ? (head.value as unknown[]) : null
      const respType = arr ? Number(arr[0]) : Number(head.value)
      const id = arr ? Number(arr[1]) : NaN
      const payload = deserializeValue(body, head.next).value
      if (respType === RpcResponseType.PromiseSuccess || respType === RpcResponseType.PromiseError || respType === RpcResponseType.PromiseErrorObj) {
        const cb = this.#rpcPending.get(id)
        if (!cb) return
        this.#rpcPending.delete(id)
        cb(
          respType === RpcResponseType.PromiseSuccess
            ? { ok: true, body: payload }
            : { ok: false, error: JSON.stringify(payload).slice(0, 300) },
        )
        return
      }
      if (respType === RpcResponseType.EventFire) {
        this.#events.onV4Message?.({ kind: 'event', id, payload })
        return
      }
      if (respType === RpcResponseType.Initialize) return
      this.#events.onV4Message?.({ kind: 'channel', respType, id, payload })
    } catch (e) {
      warn('[relay][rpc] channel 帧解析失败', String(e).slice(0, 140))
    }
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}
