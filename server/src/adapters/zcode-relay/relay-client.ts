import { createHmac, randomUUID } from 'node:crypto'
import { warn } from '../../log.ts'

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
          // 桌面在线：尝试 v4 握手（内层编码实证）
          this.#sendV4Hello()
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
      this.sendRaw({ zcode_type: 'bootstrap-request', requestId: this.#bootstrapReqId })
      info(`[relay][v4] → bootstrap-request（reqId=${this.#bootstrapReqId}）`)
    })
  }

  #onData(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    if (p.zcode_type !== 'rpc-frame') return
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
    for (const f of channelFrames(bytes)) {
      this.#ackSeq = f.ack || this.#ackSeq
      for (const line of f.payload.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.#events.onV4Message?.(JSON.parse(trimmed) as Record<string, unknown>)
        } catch {
          warn('[relay] v4 消息解析失败', trimmed.slice(0, 160))
        }
      }
    }
    void seq
  }

  /** 发送 v4 消息：先裸 NDJSON，若 8 秒无响应则改试 13 字节帧头包裹 */
  #sendV4Hello(): void {
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
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}
