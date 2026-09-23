import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppServerConnection } from './connection.ts'
import { ZcodeDbReader } from './db.ts'
import { mapStatus, messageToEvents } from './map.ts'
import type { HarnessAdapter, HistoryRange, StreamCallback } from '../../core/harness.ts'
import type { AppConfig } from '../../config.ts'
import type { CapabilitySet, StreamFrame, TaskSummary, TimelineEvent, Workspace } from '../../protocol.ts'
import { info, warn } from '../../log.ts'

interface ZcodeSessionInfo {
  sessionId: string
  workspace?: { workspacePath?: string; workspaceKey?: string }
  title?: string
  status?: string
  createdAt?: string | number
  updatedAt?: string | number
}

function toIso(v: string | number | undefined): string {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string') {
    const t = new Date(v).getTime()
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return new Date(0).toISOString()
}

function resolveZcodeCommand(configured: string): string | null {
  if (configured.trim()) return configured.trim()
  if (process.env.ZCODE_CLI) return process.env.ZCODE_CLI
  const candidates = [
    'E:\\zcode\\resources\\glm\\zcode.cjs', // 本机桌面端内置 CLI
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

const POLL_MS = 2000
const LIST_REFRESH_MS = 10_000

/**
 * ZCode 适配器。
 * 数据面：
 *  - 会话列表/状态：app-server RPC `session/list`（与本机桌面端共用 ~/.zcode 存储）
 *  - 历史时间线：只读直读 SQLite（0.16.9 的 session/read 对旧会话物化失败，见 db.ts 注释）
 *  - 实时流：legacy 订阅（本进程激活的会话）+ DB 轮询兜底（桌面端正在跑的会话也能看到推进）
 * 控制面（M2）：session/send / session/stop / 审批反向请求。
 */
export class ZcodeAdapter implements HarnessAdapter {
  readonly id = 'zcode'
  readonly label = 'ZCode'
  #conn = new AppServerConnection()
  #db = new ZcodeDbReader()
  #ready = false
  #config: AppConfig
  #onIndexChanged: () => void
  #sessions = new Map<string, ZcodeSessionInfo>()
  #subs = new Map<string, Set<StreamCallback>>()
  #pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  #lastPartRowId = new Map<string, number>()
  #pendingInteractions = new Map<string, { sessionId: string; kind: 'permission' | 'userInput'; resolve: (result: unknown) => void }>()
  #refreshTimer: ReturnType<typeof setInterval> | null = null
  #restartAttempts = 0
  #closed = false

  constructor(config: AppConfig, onIndexChanged: () => void) {
    this.#config = config
    this.#onIndexChanged = onIndexChanged
  }

  capabilities(): CapabilitySet {
    return { sendText: true, stop: true, approvals: true, review: true, terminal: false }
  }

  isReady(): boolean {
    return this.#ready
  }

  async start(): Promise<void> {
    if (this.#ready) return
    this.#db.open()
    const command = resolveZcodeCommand(this.#config.zcodeCommand)
    if (!command) {
      warn('[zcode] 未找到 zcode CLI；可在 .data/config.json 配置 zcodeCommand')
      if (this.#db.available) await this.#bootstrapDbOnly()
      return
    }
    const cwd = os.homedir()
    info(`[zcode] 启动 app-server：${command}（cwd=${cwd}）`)
    try {
      await this.#conn.start(command, ['app-server', '--stdio'], cwd, (line) => {
        info(`[zcode:server] ${line}`)
      })
      this.#conn.onExit(() => {
        this.#ready = false
        this.#onIndexChanged()
        this.#scheduleRestart()
      })
      this.#conn.onAnyNotification((method, params) => this.#onNotification(method, params))
      this.#conn.onReverseRequest((method, params) => this.#onReverse(method, params))
      await this.#waitReady()
      await this.#refreshSessions()
      // RPC 面板定期刷新（桌面端新建会话也能被发现）
      this.#refreshTimer = setInterval(() => {
        void this.#refreshSessions()
          .then(() => this.#onIndexChanged())
          .catch(() => {})
      }, LIST_REFRESH_MS)
    } catch (e) {
      warn('[zcode] app-server 启动失败，仅用 SQLite 只读面', String(e))
      if (this.#db.available) await this.#bootstrapDbOnly()
      return
    }
    this.#ready = true
    this.#restartAttempts = 0
    info(`[zcode] 就绪（RPC+SQLite），${this.#sessions.size} 个会话`)
    this.#onIndexChanged()
  }

  /** RPC 不可用时的降级：直接从 SQLite 构建会话列表 */
  async #bootstrapDbOnly(): Promise<void> {
    await this.#refreshSessionsFromDb()
    this.#ready = true
    info(`[zcode] 就绪（SQLite 只读面），${this.#sessions.size} 个会话`)
    this.#onIndexChanged()
  }

  async #waitReady(): Promise<void> {
    const deadline = Date.now() + 30_000
    let delay = 300
    while (Date.now() < deadline) {
      if (!this.#conn.running) throw new Error('app-server 已退出')
      try {
        await this.#conn.request('session/list', { includeArchived: false, limit: 1 }, 8000)
        return
      } catch (e) {
        warn('[zcode] 就绪探测重试', String(e))
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 1.5, 3000)
      }
    }
    throw new Error('app-server 就绪超时')
  }

  #scheduleRestart(): void {
    if (this.#closed) return
    this.#restartAttempts += 1
    const delay = Math.min(5000 * this.#restartAttempts, 60_000)
    warn(`[zcode] ${Math.round(delay / 1000)}s 后尝试重启 app-server（第 ${this.#restartAttempts} 次）`)
    setTimeout(() => {
      this.start().catch((e) => warn('[zcode] 重启失败', String(e)))
    }, delay)
  }

  async #refreshSessions(): Promise<void> {
    if (this.#conn.running) {
      try {
        const res = (await this.#conn.request('session/list', { includeArchived: false, limit: 200 }, 60_000)) as {
          sessions?: ZcodeSessionInfo[]
        }
        this.#sessions.clear()
        for (const s of res?.sessions ?? []) this.#sessions.set(s.sessionId, s)
        return
      } catch {
        // 落到 SQLite
      }
    }
    await this.#refreshSessionsFromDb()
  }

  async #refreshSessionsFromDb(): Promise<void> {
    this.#sessions.clear()
    for (const row of this.#db.sessions(200)) {
      this.#sessions.set(row.id, {
        sessionId: row.id,
        workspace: row.directory ? { workspacePath: row.directory, workspaceKey: row.directory } : undefined,
        title: row.title ?? undefined,
        status: undefined,
        createdAt: row.time_created,
        updatedAt: row.time_updated,
      })
    }
  }

  #onNotification(method: string, params: unknown): void {
    if (method === 'session/event') {
      const p = (params ?? {}) as Record<string, unknown>
      const sessionId = String(p.sessionId ?? '')
      const type = String(p.type ?? '')
      this.#handleSessionEvent(sessionId, type, p.payload, p)
      return
    }
    if (method === 'state.updated') {
      this.#scheduleListRefresh()
      return
    }
    if (method === 'interaction/requestPermission') {
      const p = (params ?? {}) as Record<string, unknown>
      const requestId = String(p.requestId ?? '')
      if (requestId && !this.#pendingInteractions.has(requestId)) {
        this.#pushApproval(String(p.sessionId ?? ''), requestId, p, 'permission')
      }
    }
  }

  #handleSessionEvent(sessionId: string, type: string, payload: unknown, raw: Record<string, unknown>): void {
    switch (type) {
      case 'turn.started': {
        this.#pushToSession(sessionId, { kind: 'update', summary: { status: 'running' } })
        this.#scheduleListRefresh()
        return
      }
      case 'turn.completed':
      case 'turn.failed':
      case 'session.updated':
      case 'session.titleUpdated':
      case 'session.created':
      case 'session.closed': {
        this.#scheduleListRefresh()
        return
      }
      case 'permission.requested': {
        const p = (payload ?? raw) as Record<string, unknown>
        const requestId = String(p.requestId ?? '')
        if (requestId && !this.#pendingInteractions.has(requestId)) {
          this.#pushApproval(sessionId, requestId, p, 'permission')
        }
        return
      }
      default:
        // part/message 级别的实时推进由 DB 轮询统一供给，这里只刷新列表
        this.#scheduleListRefresh()
    }
  }

  #listRefreshTimer: ReturnType<typeof setTimeout> | null = null

  #scheduleListRefresh(): void {
    if (this.#listRefreshTimer) return
    this.#listRefreshTimer = setTimeout(() => {
      this.#listRefreshTimer = null
      void this.#refreshSessions().then(() => this.#onIndexChanged()).catch(() => {})
    }, 500)
  }

  /** 服务端反向请求：必须返回 Promise，等用户裁决后再回帧（M2 控制面使用） */
  #onReverse(method: string, params: Record<string, unknown>): unknown {
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      const requestId = String(params.requestId ?? '')
      const kind = method === 'interaction/requestPermission' ? 'permission' : 'userInput'
      return new Promise((resolve) => {
        this.#pendingInteractions.set(requestId, {
          sessionId: String(params.sessionId ?? ''),
          kind,
          resolve,
        })
        this.#pushApproval(String(params.sessionId ?? ''), requestId, params, kind)
      })
    }
    warn(`[zcode] 未处理的反向请求 ${method}，已自动应答`)
    return {}
  }

  #pushApproval(sessionId: string, requestId: string, params: Record<string, unknown>, kind: 'permission' | 'userInput'): void {
    const toolName = String(params.toolName ?? params.tool ?? '工具')
    const input = params.input
    const options = Array.isArray(params.options)
      ? (params.options as Record<string, unknown>[]).map((o) => ({ optionId: String(o.optionId ?? ''), name: String(o.name ?? '') }))
      : []
    const ev: TimelineEvent = {
      id: requestId,
      kind: 'approval',
      ts: new Date().toISOString(),
      status: 'pending',
      text: kind === 'permission' ? `审批：${toolName}` : `提问：${String(params.prompt ?? toolName)}`,
      meta: {
        interactionId: requestId,
        kind,
        toolName,
        input: typeof input === 'string' ? input : JSON.stringify(input ?? {}).slice(0, 300),
        riskLevel: params.riskLevel,
        options,
      },
    }
    this.#pushToSession(sessionId, { kind: 'append', events: [ev] })
  }

  #pushToSession(sessionId: string, frame: StreamFrame): void {
    const set = this.#subs.get(sessionId)
    if (!set) return
    for (const cb of set) {
      try {
        cb(frame)
      } catch (e) {
        warn('[zcode] 订阅回调异常', String(e))
      }
    }
  }

  // ---------- 轮询兜底：桌面端正在跑的会话也能看到推进 ----------

  #startPolling(sessionId: string): void {
    if (this.#pollTimers.has(sessionId)) return
    this.#lastPartRowId.set(sessionId, this.#db.maxPartRowId(sessionId))
    const timer = setInterval(() => {
      const since = this.#lastPartRowId.get(sessionId) ?? 0
      const rows = this.#db.partsSince(sessionId, since)
      if (!rows.length) return
      this.#lastPartRowId.set(sessionId, rows[rows.length - 1]!.rowid)
      this.#pushToSession(sessionId, { kind: 'append', events: rows.map((r) => r.event) })
    }, POLL_MS)
    this.#pollTimers.set(sessionId, timer)
  }

  #stopPolling(sessionId: string): void {
    const timer = this.#pollTimers.get(sessionId)
    if (timer) clearInterval(timer)
    this.#pollTimers.delete(sessionId)
    this.#lastPartRowId.delete(sessionId)
  }

  // ---------- HarnessAdapter 接口 ----------

  async listWorkspaces(): Promise<Workspace[]> {
    const map = new Map<string, Workspace>()
    for (const s of this.#sessions.values()) {
      const wp = s.workspace?.workspacePath
      if (!wp) continue
      const id = s.workspace?.workspaceKey || wp
      if (!map.has(id)) {
        map.set(id, { id, name: path.basename(wp) || wp, path: wp })
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async listSessions(): Promise<TaskSummary[]> {
    const out: TaskSummary[] = []
    for (const s of this.#sessions.values()) {
      out.push({
        id: s.sessionId,
        workspaceId: s.workspace?.workspaceKey || s.workspace?.workspacePath || '',
        title: s.title || '未命名任务',
        status: mapStatus(s.status) as TaskSummary['status'],
        updatedAt: toIso(s.updatedAt ?? s.createdAt),
      })
    }
    return out
  }

  async history(sessionId: string, _range?: HistoryRange): Promise<TimelineEvent[]> {
    if (this.#db.available) return this.#db.history(sessionId)
    // 降级：RPC（仅对本进程激活过的会话可用）
    try {
      const res = (await this.#conn.request('session/read', { sessionId, messageLimit: 400 }, 60_000)) as {
        messages?: { info?: unknown; parts?: unknown[] }[]
      }
      const out: TimelineEvent[] = []
      for (const msg of res?.messages ?? []) out.push(...messageToEvents(msg as never))
      return out
    } catch {
      return []
    }
  }

  subscribe(sessionId: string, cb: StreamCallback): () => void {
    let set = this.#subs.get(sessionId)
    if (!set) {
      set = new Set()
      this.#subs.set(sessionId, set)
      this.#startPolling(sessionId)
      // legacy 订阅：仅对本进程激活的会话生效，失败不影响轮询面
      if (this.#conn.running) {
        void this.#conn
          .requestUuid('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' }, 15_000)
          .catch(() => {})
      }
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (!set!.size) {
        this.#subs.delete(sessionId)
        this.#stopPolling(sessionId)
      }
    }
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    if (!this.#conn.running) throw new Error('app-server 未运行，无法发送')
    await this.#conn.request('session/send', { sessionId, content: text }, 30_000)
  }

  async stopSession(sessionId: string): Promise<void> {
    if (!this.#conn.running) throw new Error('app-server 未运行')
    await this.#conn.request('session/stop', { sessionId }, 30_000)
  }

  async resolveInteraction(sessionId: string, interactionId: string, outcome: 'approve' | 'reject'): Promise<void> {
    const entry = this.#pendingInteractions.get(interactionId)
    if (!entry) {
      warn(`[zcode] 交互 ${interactionId} 不存在或已处理`)
      return
    }
    this.#pendingInteractions.delete(interactionId)
    if (entry.kind === 'permission') {
      entry.resolve({ decision: outcome === 'approve' ? 'allow' : 'deny' })
    } else {
      entry.resolve({ action: outcome === 'approve' ? 'accept' : 'decline' })
    }
    this.#pushToSession(sessionId, {
      kind: 'update',
      events: [{ id: interactionId, kind: 'approval', ts: new Date().toISOString(), status: 'completed', text: outcome === 'approve' ? '已批准' : '已拒绝' }],
    })
  }

  async stop(): Promise<void> {
    this.#closed = true
    this.#ready = false
    if (this.#refreshTimer) clearInterval(this.#refreshTimer)
    for (const sessionId of [...this.#pollTimers.keys()]) this.#stopPolling(sessionId)
    this.#db.close()
    await this.#conn.close()
  }
}
