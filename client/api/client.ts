import { reactive } from 'vue'
import type { HelloFrame, ServerFrame } from './types'

type PushHandler = (kind: string, data: unknown) => void

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface SubEntry {
  topic: 'sessions-index' | 'session-stream'
  params?: { sessionId?: string; includeArchived?: boolean }
  handler: PushHandler
}

/** 连接状态（全局响应式，页面直接读） */
export const conn = reactive({
  connected: false,
  hello: null as HelloFrame | null,
  retryCount: 0,
})

const MAX_BACKOFF = 15_000

class Api {
  #sock: WebSocket | null = null
  #reqSeq = 0
  #pending = new Map<string, Pending>()
  #subs = new Map<string, SubEntry>()
  #backoff = 1000
  #hbTimer: ReturnType<typeof setInterval> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #closedByUser = false

  connect(): void {
    this.#closedByUser = false
    this.#open()
  }

  close(): void {
    this.#closedByUser = true
    this.#teardown()
    this.#sock?.close()
    this.#sock = null
  }

  #teardown(): void {
    if (this.#hbTimer) {
      clearInterval(this.#hbTimer)
      this.#hbTimer = null
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    this.#pending.clear()
  }

  #directWs = false // HBuilderX dev(5173) 无代理时直连 3930 的兜底开关

  #url(): string {
    // #ifdef H5
    const host = location.hostname
    const isLoop = host === 'localhost' || host === '127.0.0.1'
    // HBuilderX dev（非 3930 端口）没有 /ws 代理，vite 对未知升级会永久挂起——直接连服务端口
    if (isLoop && location.port !== '3930') {
      return `ws://${host}:3930/ws`
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/ws`
    // #endif
    // #ifndef H5
    const base = (uni.getStorageSync('zp_base') as string) || 'http://127.0.0.1:3930'
    return base.replace(/^http/, 'ws') + '/ws'
    // #endif
  }

  #open(): void {
    // #ifdef H5
    const sock = new WebSocket(this.#url())
    sock.onopen = () => this.#onOpen()
    sock.onmessage = (ev) => this.#onMessage(String(ev.data))
    sock.onclose = () => this.#onClose()
    sock.onerror = () => {
      // close 事件会跟上
    }
    this.#sock = sock
    // #endif
    // #ifndef H5
    const task = uni.connectSocket({ url: this.#url() })
    task.onOpen(() => this.#onOpen())
    task.onMessage((m) => this.#onMessage(String(m.data)))
    task.onClose(() => this.#onClose())
    task.onError(() => {})
    this.#sock = task as unknown as WebSocket
    // #endif
  }

  #onOpen(): void {
    conn.connected = true
    conn.retryCount = 0
    this.#backoff = 1000
    // 重放全部订阅
    for (const [id, s] of this.#subs) {
      this.#sendRaw({ t: 'sub', id, topic: s.topic, params: s.params })
    }
    // 心跳：应用层 ping，超时即主动断开触发重连
    this.#hbTimer = setInterval(() => {
      this.request('ping', undefined, 5000).catch(() => this.#sock?.close())
    }, 25_000)
  }

  #onMessage(raw: string): void {
    let frame: ServerFrame
    try {
      frame = JSON.parse(raw) as ServerFrame
    } catch {
      return
    }
    if (frame.t === 'hello') {
      conn.hello = frame
      return
    }
    if (frame.t === 'res') {
      const p = this.#pending.get(frame.id)
      if (!p) return
      this.#pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.ok) p.resolve(frame.data)
      else p.reject(new Error(frame.error?.message ?? frame.error?.code ?? '请求失败'))
      return
    }
    if (frame.t === 'push') {
      const s = this.#subs.get(frame.sub)
      s?.handler(frame.kind, frame.data)
    }
  }

  #onClose(): void {
    const wasConnected = conn.connected
    conn.connected = false
    this.#teardown()
    if (this.#closedByUser) return
    conn.retryCount += 1
    // HBuilderX dev（5173 等非 3930 端口、回环主机）连续失败后切直连 3930
    // #ifdef H5
    {
      const host = location.hostname
      const isLoop = host === 'localhost' || host === '127.0.0.1'
      if (!this.#directWs && conn.retryCount >= 2 && isLoop && location.port !== '3930') {
        this.#directWs = true
        console.warn('[zp] 开发模式：WS 改为直连 3930')
      }
    }
    // #endif
    const delay = Math.min(this.#backoff * Math.pow(1.6, conn.retryCount - 1), MAX_BACKOFF)
    this.#reconnectTimer = setTimeout(() => this.#open(), delay + Math.random() * 400)
    if (wasConnected || conn.retryCount <= 1) {
      console.warn(`[zp] 连接断开，${Math.round(delay / 100) / 10}s 后重连（第 ${conn.retryCount} 次）`)
    }
  }

  #sendRaw(frame: unknown): void {
    if (this.#sock && this.#sock.readyState === 1) this.#sock.send(JSON.stringify(frame))
  }

  request<T = unknown>(method: string, payload?: unknown, timeoutMs = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.#sock || this.#sock.readyState !== 1) {
        reject(new Error('未连接'))
        return
      }
      const id = `r${++this.#reqSeq}`
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('请求超时'))
      }, timeoutMs)
      this.#pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      this.#sendRaw({ t: 'req', id, method, payload })
    })
  }

  /** 订阅；断线重连后自动重放 */
  subscribe(id: string, topic: 'sessions-index' | 'session-stream', params: { sessionId?: string; includeArchived?: boolean } | undefined, handler: PushHandler): void {
    this.#subs.set(id, { topic, params, handler })
    this.#sendRaw({ t: 'sub', id, topic, params })
  }

  unsubscribe(id: string): void {
    this.#subs.delete(id)
    this.#sendRaw({ t: 'unsub', id })
  }
}

export const api = new Api()

// ---------- HTTP（登录等少量 REST） ----------

interface HttpResult<T> {
  statusCode: number
  data: T
}

// 开发兜底：HBuilderX dev 无代理时直连 3930（仅回环主机，需服务端放行回环 CORS）
let httpBase = ''

/** 探测是否需要直连 3930（HBuilderX dev 场景；幂等，页面加载早期调用一次） */
export async function ensureHttpBase(): Promise<void> {
  // #ifdef H5
  if (httpBase) return
  const host = location.hostname
  const isLoop = host === 'localhost' || host === '127.0.0.1'
  if (!isLoop || !location.port || location.port === '3930') return
  const candidate = `http://${host}:3930`
  const ok = await new Promise<boolean>((resolve) => {
    uni.request({
      url: candidate + '/api/bootstrap',
      timeout: 3000,
      success: (r) => resolve(r.statusCode === 200 || r.statusCode === 401),
      fail: () => resolve(false),
    })
  })
  if (ok) {
    httpBase = candidate
    console.warn('[zp] 开发模式：HTTP 直连 ' + candidate)
  }
  // #endif
}

function http<T>(method: 'GET' | 'POST', url: string, data?: unknown): Promise<HttpResult<T>> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: httpBase + url,
      method,
      data: data as Record<string, unknown> | undefined,
      timeout: 10_000,
      withCredentials: true,
      success: (res) => resolve({ statusCode: res.statusCode ?? 0, data: res.data as T }),
      fail: (err) => reject(new Error(err.errMsg ?? '网络错误')),
    })
  })
}

export const httpGet = <T,>(url: string) => http<T>('GET', url)
export const httpPost = <T,>(url: string, data?: unknown) => http<T>('POST', url, data)
