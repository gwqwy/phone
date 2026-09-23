import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { info, warn } from '../../log.ts'

/**
 * `zcode app-server` 的 stdio NDJSON 客户端。
 * 帧格式（见 .reference/zcode packages/shared/src/zcode-protocol）：
 *   请求      { id, method, params? }
 *   响应      { id, result } | { id, error: { code, message, data? } }
 *   通知      { method, params? }
 * 服务端还会反向发请求（如 interaction/requestPermission），同样用 { id, method, params }
 * 信封、需要回 { id, result }。
 */
export interface ZcodeRequest {
  id: string
  method: string
  params?: unknown
}

export interface ZcodeErrorFrame {
  code: number
  message: string
  data?: unknown
}

type NotificationHandler = (params: unknown) => void
type ReverseHandler = (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown

const DEFAULT_TIMEOUT = 60_000

export class AppServerConnection {
  #proc: ChildProcess | null = null
  #buffer = ''
  #seq = 0
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  #notificationHandlers = new Map<string, Set<NotificationHandler>>()
  #anyNotification: ((method: string, params: unknown) => void) | null = null
  #reverseHandler: ReverseHandler | null = null
  #exitHandlers: (() => void)[] = []

  get running(): boolean {
    return this.#proc !== null && this.#proc.exitCode === null
  }

  /** command 形如 `E:\...\zcode.cjs`（自动加 node）或 PATH 中的可执行名；env 追加注入子进程 */
  start(command: string, args: string[], cwd: string, onLog?: (line: string) => void, env?: Record<string, string>): Promise<void> {
    const useNode = /\.(cjs|mjs|js)$/i.test(command)
    const file = useNode ? process.execPath : command
    const argv = useNode ? [command, ...args] : args
    return new Promise((resolve, reject) => {
      const proc = spawn(file, argv, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : undefined,
      })
      this.#proc = proc
      let settled = false

      proc.on('error', (e) => {
        if (!settled) {
          settled = true
          reject(new Error(`无法启动 ${command}: ${e.message}`))
        }
        this.#handleExit()
      })

      proc.on('exit', (code) => {
        info(`[zcode] app-server 进程退出（code=${code}）`)
        if (code !== 0 && code !== null) {
          warn(`[zcode] app-server 异常退出 code=${code}——常见原因：另一个 zphone/app-server 实例占用了 ~/.zcode 数据库，或 CLI 报配置错误（见上方 [zcode:server] stderr 行）`)
        }
        this.#rejectAll('app-server 进程已退出')
        this.#handleExit()
        if (!settled) {
          settled = true
          reject(new Error(`app-server 启动即退出（code=${code}）`))
        }
      })

      let out = ''
      proc.stdout!.setEncoding('utf8')
      proc.stdout!.on('data', (chunk: string) => {
        out += chunk
        let idx = out.indexOf('\n')
        while (idx >= 0) {
          const line = out.slice(0, idx)
          out = out.slice(idx + 1)
          if (line.trim().length > 0) this.#dispatchLine(line)
          idx = out.indexOf('\n')
        }
      })

      proc.stderr!.setEncoding('utf8')
      proc.stderr!.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) onLog?.(line)
        }
      })

      // 就绪探测：进程存活 800ms 无 spawn 错误即认为启动成功
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve()
        }
      }, 800)
    })
  }

  #handleExit(): void {
    this.#proc = null
    for (const h of this.#exitHandlers) h()
    this.#exitHandlers = []
  }

  onExit(cb: () => void): void {
    if (this.#proc) this.#exitHandlers.push(cb)
    else cb()
  }

  #rejectAll(msg: string): void {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(msg))
    }
    this.#pending.clear()
  }

  #dispatchLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      warn('[zcode] 非 JSON 帧', line.slice(0, 200))
      return
    }
    if (typeof frame.method === 'string' && frame.id === undefined) {
      // 通知
      const method = frame.method
      const params = frame.params
      const set = this.#notificationHandlers.get(method)
      if (set) for (const h of set) h(params)
      this.#anyNotification?.(method, params)
      return
    }
    if (typeof frame.method === 'string' && typeof frame.id !== 'undefined') {
      // 服务端反向请求，需要回 { id, result }
      const id = frame.id
      const method = frame.method
      const params = (frame.params ?? {}) as Record<string, unknown>
      void Promise.resolve()
        .then(() => this.#reverseHandler?.(method, params))
        .then((result) => {
          this.#write({ id, result: result ?? {} })
        })
        .catch((e) => {
          warn(`[zcode] 反向请求处理失败 ${method}`, String(e))
          this.#write({ id, error: { code: -32000, message: String(e) } })
        })
      return
    }
    if (typeof frame.id !== 'undefined' && (frame.result !== undefined || frame.error !== undefined)) {
      const key = String(frame.id)
      const p = this.#pending.get(key)
      if (!p) return
      this.#pending.delete(key)
      clearTimeout(p.timer)
      if (frame.error !== undefined) {
        const err = frame.error as ZcodeErrorFrame
        p.reject(new Error(`[${err.code}] ${err.message}`))
      } else {
        p.resolve(frame.result)
      }
    }
  }

  #write(obj: unknown): void {
    if (!this.#proc?.stdin?.writable) return
    this.#proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('app-server 未运行'))
        return
      }
      const id = ++this.#seq
      const timer = setTimeout(() => {
        this.#pending.delete(String(id))
        reject(new Error(`请求超时: ${method}`))
      }, timeoutMs)
      this.#pending.set(String(id), { resolve, reject, timer })
      this.#write({ id, method, params })
    })
  }

  /** 客户端主动发起的带 uuid 的请求（协议要求部分场景用 uuid） */
  requestUuid(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('app-server 未运行'))
        return
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`请求超时: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ id, method, params })
    })
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.#notificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.#notificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  onAnyNotification(handler: (method: string, params: unknown) => void): void {
    this.#anyNotification = handler
  }

  /** 注册服务端反向请求处理器（interaction/requestPermission 等） */
  onReverseRequest(handler: ReverseHandler): void {
    this.#reverseHandler = handler
  }

  async close(): Promise<void> {
    const proc = this.#proc
    if (!proc) return
    this.#rejectAll('连接关闭')
    try {
      proc.stdin?.end()
    } catch {
      // 已关闭
    }
    const killer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // 已退出
      }
    }, 3000)
    await new Promise<void>((resolve) => {
      proc.once('exit', () => {
        clearTimeout(killer)
        resolve()
      })
    })
    this.#proc = null
  }
}
