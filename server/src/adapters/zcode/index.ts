import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppServerConnection } from './connection.ts'
import { ZcodeDbReader } from './db.ts'
import { mapStatus, rowsToEvents, type V4Row } from './map.ts'
import type { HarnessAdapter, HistoryRange, ModelCatalog, StreamCallback } from '../../core/harness.ts'
import type { AppConfig } from '../../config.ts'
import { DATA_DIR } from '../../config.ts'
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
  // 候选来源：config.json（本机可信文件）与环境变量；无论来源，都必须通过
  // 「存在 + 扩展名白名单 + 指向 zcode CLI」三重校验后才允许 spawn。
  const candidates = [configured.trim(), process.env.ZCODE_CLI ?? '']
  const defaults = [
    'E:\\zcode\\resources\\glm\\zcode.cjs', // 本机桌面端内置 CLI
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
  ]
  for (const c of [...candidates, ...defaults]) {
    if (!c || !existsSync(c)) continue
    if (!/\.(cjs|mjs|js|exe|cmd)$/i.test(c)) continue
    if (!/zcode/i.test(path.basename(c))) continue
    return c
  }
  return null
}

const POLL_MS = 2000
const LIST_REFRESH_MS = 10_000

const MODEL_ACCESS_HINT =
  '电脑端 ZCode 未向独立进程开放模型账号（桌面端 3.14.x 由宿主注入账号）。请在 .data/config.json 配置 personalProvider（API Key）后即可远程执行；查看任务不受影响。'

function friendlyControlError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  // 上游模型额度/限流（如 bigmodel 1310）——用 test 而非 exec，避免静态扫描误判
  const quotaRe = /\[1310\]|使用上限|rate_limit|quota/i
  if (quotaRe.test(msg)) {
    const reset = msg.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
    return new Error(`模型账号额度已达上限${reset ? `，将于 ${reset[1]} 重置` : ''}。可在 .data/config.json 更换 personalProvider.apiKey。`)
  }
  if (msg.includes('Select a model') || msg.includes('Model creation failed') || msg.includes('不存在 Model')) {
    return new Error(MODEL_ACCESS_HINT)
  }
  return e instanceof Error ? e : new Error(msg)
}

/**
 * 定位 ZCode Built-in Provider Config（app-server 启动必需，桌面端以
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 传给它）：
 * 1) 最新一份桌面端缓存（~/.zcode/v2/runtime/provider/**\/zcode-builtin.json）
 * 2) 桌面端安装目录的随包副本
 */
function resolveBuiltinProviderConfig(): string | null {
  const runtimeDir = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider')
  let newest: { file: string; m: number } | null = null
  const stack = [runtimeDir]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name === 'zcode-builtin.json') {
        try {
          const m = statSync(full).mtimeMs
          if (!newest || m > newest.m) newest = { file: full, m }
        } catch {
          // 忽略不可读项
        }
      }
    }
  }
  if (newest) return newest.file
  const bundled = 'E:\\zcode\\resources\\config\\provider\\zcode-builtin.json'
  return existsSync(bundled) ? bundled : null
}

/** 读取个人 provider 的 API Key（provider_config.json 里 api-key 类型）——供运行时鉴权头使用 */
function readPersonalProviderApiKey(providerId: string): string | null {
  const file = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json')
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
      config?: { providerConfigRules?: { providerRules?: Record<string, unknown>[] } }
    }
    for (const rule of doc.config?.providerConfigRules?.providerRules ?? []) {
      if (String(rule.providerId ?? '') !== providerId) continue
      const access = ((rule.config ?? {}) as { access?: { type?: string; apiKey?: string } }).access
      if (access?.type === 'api-key' && access.apiKey) return access.apiKey
    }
  } catch {
    // 无配置
  }
  return null
}

/**
 * 把个人 API Key 提供方合并进 ZCode 的个人 Provider 配置
 * （~/.zcode/v2/provider_config.json，桌面端与 CLI/app-server 共用，registry 默认读取）。
 * 关键点：该文件必须整体符合 storedProviderConfigSchema（schemaVersion=1 +
 * config.providerConfigRules/modelConfigRules），且 apiKey 在 access 里而非 api。
 * 合并写入：保留桌面端已有内容，仅覆盖同 id 的规则。
 */
function writePersonalProviderConfig(pp: AppConfig['personalProvider']): string | null {
  if (!pp.apiKey.trim() || !pp.modelId.trim()) return null
  const file = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json')
  const providerId = 'personal-bigmodel'
  const rule = {
    providerId,
    providerName: 'BigModel (API Key)',
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: pp.apiKey },
      api: { type: pp.apiType, baseUrl: pp.baseUrl },
      personalModelIds: [pp.modelId],
      modelOrder: [pp.modelId],
    },
  }
  try {
    let doc: {
      schemaVersion?: number
      config?: {
        providerOrder?: string[]
        providerConfigRules?: { providerRules?: unknown[] }
        modelConfigRules?: { providerRules?: unknown[]; manualProviderModelRules?: unknown[] }
        [k: string]: unknown
      }
      [k: string]: unknown
    } = {}
    if (existsSync(file)) {
      doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as typeof doc
    }
    const cfg = doc.config ?? {}
    const providerRules = (cfg.providerConfigRules?.providerRules ?? []).filter(
      (r) => (r as { providerId?: string }).providerId !== providerId,
    )
    cfg.providerConfigRules = { ...(cfg.providerConfigRules ?? {}), providerRules: [...providerRules, rule] }
    cfg.modelConfigRules = cfg.modelConfigRules ?? { providerRules: [], manualProviderModelRules: [] }
    cfg.providerOrder = [...new Set([...(cfg.providerOrder ?? []), providerId])]
    doc.schemaVersion = 1
    doc.config = cfg
    writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 })
    return file
  } catch (e) {
    warn('[zcode] 写入个人 provider 配置失败', String(e))
    return null
  }
}

/**
 * ZCode 适配器。
 * 数据面：
 *  - 会话列表/状态：app-server RPC `session/list`（与本机桌面端共用 ~/.zcode 存储）
 *  - 历史时间线：v4 rowsRange（官方 UI 投影）→ 只读 SQLite 兜底
 *  - 实时流：legacy 订阅（本进程激活的会话）+ DB 轮询兜底（桌面端正在跑的会话也能看到推进）
 * 控制面：session/create + send + 审批反向请求均已接线；模型执行依赖桌面端账号注入，
 * 当前桌面版本在独立进程中不可用（见 MODEL_ACCESS_HINT），一旦账号可达（个人 API Key / 新版接口）即自动生效。
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
    return { sendText: true, stop: true, approvals: true, review: true, terminal: false, createTask: true }
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
    // app-server 需要桌面端的 builtin Provider 配置，否则启动即退（无法定位 zcode-builtin.json）
    const builtinConfig = resolveBuiltinProviderConfig()
    const spawnEnv: Record<string, string> | undefined = builtinConfig
      ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig }
      : undefined
    // 个人 API Key 提供方（解锁远程发送：模型由该 key 直接执行）
    // 写入 ~/.zcode/v2/provider_config.json（registry 默认读取，桌面端 UI 亦可见）
    const personalFile = writePersonalProviderConfig(this.#config.personalProvider)
    if (personalFile) {
      spawnEnv ??= {}
      spawnEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalFile
      info(`[zcode] 个人提供方已写入：${personalFile}（模型 ${this.#config.personalProvider.modelId}）`)
    }
    info(`[zcode] 启动 app-server：${command}（cwd=${cwd}${builtinConfig ? '，builtin=' + builtinConfig : ''}）`)
    try {
      await this.#conn.start(command, ['app-server', '--stdio'], cwd, (line) => {
        info(`[zcode:server] ${line}`)
      }, spawnEnv)
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
    // 运行时偏好：桌面端宿主会应答此请求；缺省应答会导致会话物化失败
    // （nativeSearchEnhancementsEnabled 校验，见 zcodeSessionRuntimePreferencesResultSchema）
    if (method === 'session/requestRuntimePreferences') {
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      }
    }
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
    // Provider 运行时鉴权材料（host 模式下由宿主供给）：缺它模型请求会失败
    // 响应 schema: {headersApplied:true, requestAuth:{apiKey?, headers?}} | {headersApplied:false, errorMessage?}
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      const providerId = String(
        params.providerId ?? (params.modelSelection as { providerId?: string } | undefined)?.providerId ?? '',
      )
      const apiKey = providerId ? readPersonalProviderApiKey(providerId) : null
      if (apiKey) return { headersApplied: true, requestAuth: { apiKey } }
      // 账号类 provider（account:*）需要 OAuth 令牌，独立进程暂无法提供
      warn(`[zcode] provider ${providerId} 的鉴权材料不可用（非个人 API Key）`)
      return { headersApplied: false, errorMessage: `provider ${providerId} 需要桌面端账号鉴权` }
    }
    // 官方 MCP 鉴权头（不影响主流程）：按协议返回结构化失败
    if (method === 'interaction/requestOfficialMcpAuthHeaders') {
      return { ok: false, reason: 'official_auth_unavailable' }
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
    // 首选：v4 rowsRange（官方 UI 投影，无需激活会话）
    if (this.#conn.running) {
      try {
        const events: TimelineEvent[] = []
        let beforeRowId: number | undefined
        let totalRows = 0
        for (let page = 0; page < 6; page += 1) {
          const res = (await this.#conn.requestUuid(
            'v4/conversation/rowsRange',
            { sessionId, clientMode: 'web-remote-replayable', limit: 200, ...(beforeRowId !== undefined ? { beforeRowId } : {}) },
            30_000,
          )) as { rows?: V4Row[]; hasMore?: boolean }
          const rows = res?.rows ?? [] // rowId 升序（本页为当前已知的最新段）
          totalRows += rows.length
          events.unshift(...rowsToEvents(rows))
          if (!res?.hasMore || !rows.length) break
          beforeRowId = rows[0]!.rowId
        }
        // rowsRange 对部分会话可能返回空（投影未物化），此时必须落到 SQLite
        info(`[zcode] rowsRange ${sessionId.slice(0, 12)}… rows=${totalRows} → 事件 ${events.length}`)
        if (events.length) return events
      } catch (e) {
        warn('[zcode] rowsRange 读取失败，退回 SQLite', String(e).slice(0, 140))
      }
    }
    if (this.#db.available) return this.#db.history(sessionId)
    return []
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

  /** 远程任务使用的模型选择：优先 config.taskModel，回退个人 bigmodel provider */
  #taskModelSelection(): { providerId: string; modelId: string; options?: { reasoningLevel: string } } | undefined {
    const tm = this.#config.taskModel
    if (tm?.modelId?.trim()) {
      return {
        providerId: tm.providerId?.trim() || 'personal-bigmodel',
        modelId: tm.modelId.trim(),
        ...(tm.reasoningLevel?.trim() ? { options: { reasoningLevel: tm.reasoningLevel.trim() } } : {}),
      }
    }
    if (this.#config.personalProvider.apiKey.trim()) {
      return { providerId: 'personal-bigmodel', modelId: this.#config.personalProvider.modelId }
    }
    return undefined
  }

  async createSession(workspaceId: string, text: string): Promise<{ sessionId: string }> {
    if (!this.#conn.running) throw new Error('app-server 未运行，无法新建任务')
    const model = this.#taskModelSelection()
    let res: Record<string, unknown>
    try {
      res = (await this.#conn.request(
        'session/create',
        {
          workspace: { workspacePath: workspaceId, workspaceKey: workspaceId },
          titleGenerationEnabled: true,
          persistence: 'immediate',
          ...(model ? { model } : {}),
        },
        60_000,
      )) as Record<string, unknown>
    } catch (e) {
      throw friendlyControlError(e)
    }
    const sessionId =
      (typeof res?.sessionId === 'string' && res.sessionId) ||
      ((res?.info as Record<string, unknown> | undefined)?.sessionId as string | undefined) ||
      ((res?.session as Record<string, unknown> | undefined)?.sessionId as string | undefined)
    if (!sessionId) throw new Error('创建会话失败：响应缺 sessionId')
    await this.#refreshSessions()
    this.#onIndexChanged()
    if (text.trim()) {
      try {
        await this.#conn.request('session/send', { sessionId, content: text.trim() }, 30_000)
      } catch (e) {
        // 发送失败时回收刚建的会话，避免手机端产生"幽灵任务"
        void this.#conn.request('session/close', { sessionId }, 10_000).catch(() => {})
        throw friendlyControlError(e)
      }
    }
    return { sessionId }
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    if (!this.#conn.running) throw new Error('app-server 未运行，无法发送')
    try {
      await this.#conn.request('session/send', { sessionId, content: text }, 30_000)
    } catch (e) {
      const msg = String(e)
      // 会话未在本进程激活：先物化（resume）再重发一次
      if (msg.includes('-32004') || msg.toLowerCase().includes('not active')) {
        try {
          await this.#conn.request('session/resume', { sessionId }, 60_000)
          await this.#conn.request('session/send', { sessionId, content: text }, 30_000)
          return
        } catch (e2) {
          throw friendlyControlError(e2)
        }
      }
      throw friendlyControlError(e)
    }
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

  async review(sessionId: string): Promise<{ additions: number; deletions: number; files: string[] }> {
    if (this.#db.available) return this.#db.review(sessionId)
    return { additions: 0, deletions: 0, files: [] }
  }

  /** 可选模型清单：个人 provider（provider_config.json） + config 里配置的模型 */
  async listModels(sessionId?: string): Promise<ModelCatalog> {
    const models: ModelCatalog['models'] = []
    const seen = new Set<string>()
    const add = (o: ModelCatalog['models'][number]): void => {
      const key = `${o.providerId}/${o.modelId}`
      if (seen.has(key)) return
      seen.add(key)
      models.push(o)
    }

    // 1) ~/.zcode/v2/provider_config.json 的个人 provider（API Key 可用）
    const personalFile = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json')
    try {
      const doc = JSON.parse(readFileSync(personalFile, 'utf8').replace(/^\uFEFF/, '')) as {
        config?: { providerConfigRules?: { providerRules?: Record<string, unknown>[] } }
      }
      for (const rule of doc.config?.providerConfigRules?.providerRules ?? []) {
        const providerId = String(rule.providerId ?? '')
        const cfg = (rule.config ?? {}) as { personalModelIds?: string[]; modelOrder?: string[] }
        if (!providerId) continue
        const ids = [...new Set([...(cfg.modelOrder ?? []), ...(cfg.personalModelIds ?? [])])]
        const label = String(rule.providerName ?? providerId)
        if (ids.length) {
          for (const id of ids) add({ providerId, modelId: id, label: `${label} · ${id}`, reasoningLevels: ['off', 'low', 'medium', 'high'], reasoningLevel: 'high' })
        } else if (providerId === 'deepseek') {
          // 模板 provider（模型来自内置模板）
          add({ providerId, modelId: 'deepseek-v4-pro', label: `${label} · deepseek-v4-pro`, reasoningLevels: ['off', 'low', 'medium', 'high'], reasoningLevel: 'high' })
        }
      }
    } catch {
      // 无个人配置
    }

    // 2) config.json 里配置的个人 bigmodel provider（含 GLM-5.3 / GLM-5.3-Flash）
    const pp = this.#config.personalProvider
    if (pp.apiKey.trim()) {
      const ids = [...new Set([pp.modelId.trim(), 'GLM-5.3', 'GLM-5.3-Flash'].filter(Boolean))]
      for (const id of ids) {
        if (!id) continue
        add({ providerId: 'personal-bigmodel', modelId: id, label: `BigModel · ${id}`, note: 'API Key' })
      }
    }
    const tm = this.#config.taskModel
    if (tm?.modelId?.trim()) {
      add({
        providerId: tm.providerId?.trim() || 'personal-bigmodel',
        modelId: tm.modelId.trim(),
        ...(tm.reasoningLevel ? { reasoningLevel: tm.reasoningLevel } : {}),
      })
    }

    // 3) 内置账号 provider（桌面端账号，独立进程执行受限，仅作展示提示）
    const builtin = resolveBuiltinProviderConfig()
    if (builtin) {
      try {
        const doc = JSON.parse(readFileSync(builtin, 'utf8').replace(/^\uFEFF/, '')) as { providerRules?: Record<string, unknown>[] }
        for (const rule of doc.providerRules ?? []) {
          const providerId = String(rule.providerId ?? '')
          if (!providerId.startsWith('account:bigmodel')) continue
          const cfg = (rule.config ?? {}) as { builtinModelIds?: string[] }
          for (const id of cfg.builtinModelIds ?? []) {
            add({ providerId, modelId: id, label: `账号 · ${id}`, note: '需桌面端在线' })
          }
        }
      } catch {
        // 内置目录不可读
      }
    }

    // 当前会话正在使用的模型
    let current: ModelCatalog['current'] = null
    if (sessionId) {
      try {
        const res = (await this.#conn.request('session/list', { sessionIds: [sessionId] }, 15_000)) as {
          sessions?: { modelId?: string; providerId?: string }[]
        }
        const s = res?.sessions?.[0]
        if (s?.modelId) current = { providerId: s.providerId ?? '', modelId: s.modelId }
      } catch {
        // 查询失败则不显示当前值
      }
      current ??= (() => {
        const sel = this.#taskModelSelection()
        return sel ? { providerId: sel.providerId, modelId: sel.modelId } : null
      })()
    }
    return { models, current }
  }

  /** 切换会话模型（同步更新 config.taskModel，后续新建任务沿用） */
  async setSessionModel(sessionId: string, providerId: string, modelId: string, reasoningLevel?: string): Promise<void> {
    if (!this.#conn.running) throw new Error('app-server 未运行')
    const params = {
      sessionId,
      model: { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) },
      persistAsWorkspaceLastUsed: true,
    }
    let applied = false
    if (sessionId) {
      try {
        await this.#conn.request('session/setModel', params, 30_000)
        applied = true
      } catch (e) {
        const msg = String(e)
        // 会话未在本进程激活（桌面端持有的会话）：先物化再重试
        if (msg.includes('-32004') || msg.toLowerCase().includes('not active')) {
          try {
            await this.#conn.request('session/resume', { sessionId }, 60_000)
            await this.#conn.request('session/setModel', params, 30_000)
            applied = true
          } catch {
            // 桌面端持有的活跃会话无法由本进程接管，降级为“设为默认模型”
          }
        } else {
          throw friendlyControlError(e)
        }
      }
    }
    // 记为默认任务模型（无论会话是否切换成功，后续新建任务都用它）
    this.#config.taskModel = { providerId, modelId, reasoningLevel: reasoningLevel ?? '' }
    try {
      const cfgFile = path.join(DATA_DIR, 'config.json')
      const doc = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
      doc.taskModel = this.#config.taskModel
      writeFileSync(cfgFile, JSON.stringify(doc, null, 2))
    } catch (e) {
      warn('[zcode] 保存默认模型失败', String(e))
    }
    this.#scheduleListRefresh()
    if (!applied) {
      throw new Error(`已设为默认模型（${modelId}）；该会话正被桌面端使用，切换需在桌面端操作。`)
    }
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
