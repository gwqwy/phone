import type { IncomingMessage } from 'node:http'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthService } from './auth.ts'
import { effectiveLevel } from './auth.ts'
import type { HarnessAdapter, HarnessRegistry } from './core/harness.ts'
import type { MetaStore, TaskMeta } from './core/meta.ts'
import type { ClientFrame, ServerFrame, TaskSummary, Workspace } from './protocol.ts'
import { info, warn } from './log.ts'

export interface WsCtx {
  auth: AuthService
  registry: HarnessRegistry
  meta: MetaStore
}

interface SubEntry {
  topic: 'sessions-index' | 'session-stream'
  params?: { sessionId?: string; includeArchived?: boolean }
  cleanup?: () => void
}

const HEARTBEAT_MS = 30_000

export function attachWs(server: Server, ctx: WsCtx): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== '/ws') {
      socket.destroy()
      return
    }
    const level = effectiveLevel(req.headers.host, req.socket.remoteAddress)
    if (!ctx.auth.check(req, level)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      socket.destroy()
      warn('WS 升级被拒绝（未认证）')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    setupConnection(ws, req, ctx)
  })
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
}

function setupConnection(ws: WebSocket, req: IncomingMessage, ctx: WsCtx): void {
  const subs = new Map<string, SubEntry>()
  let misses = 0

  const hb = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return
    misses += 1
    if (misses >= 2) {
      ws.terminate()
      return
    }
    ws.ping()
  }, HEARTBEAT_MS)
  ws.on('pong', () => {
    misses = 0
  })

  ws.on('close', () => {
    clearInterval(hb)
    for (const s of subs.values()) s.cleanup?.()
    subs.clear()
  })

  ws.on('error', (e) => {
    warn('WS 连接错误', String(e))
  })

  ws.on('message', (raw) => {
    let frame: ClientFrame
    try {
      frame = JSON.parse(String(raw)) as ClientFrame
    } catch {
      send(ws, { t: 'res', id: '', ok: false, error: { code: 'bad-frame', message: 'JSON 解析失败' } })
      return
    }
    try {
      if (frame.t === 'req') {
        void handleReq(ws, ctx, frame.id, frame.method, frame.payload)
      } else if (frame.t === 'sub') {
        handleSub(ws, ctx, subs, frame)
      } else if (frame.t === 'unsub') {
        const s = subs.get(frame.id)
        s?.cleanup?.()
        subs.delete(frame.id)
      }
    } catch (e) {
      if (frame.t === 'req') {
        send(ws, { t: 'res', id: frame.id, ok: false, error: { code: 'internal', message: String(e) } })
      }
      warn('WS 帧处理异常', String(e))
    }
  })

  send(ws, {
    t: 'hello',
    server: 'zcode-phone',
    adapters: ctx.registry.list(),
  })
  info(`WS 连接建立（${req.socket.remoteAddress}）`)
}

// ---------- 请求路由 ----------

async function handleReq(
  ws: WebSocket,
  ctx: WsCtx,
  id: string,
  method: string,
  payload: unknown,
): Promise<void> {
  const ok = (data: unknown) => send(ws, { t: 'res', id, ok: true, data })
  const fail = (code: string, message: string) => send(ws, { t: 'res', id, ok: false, error: { code, message } })
  const p = (payload ?? {}) as Record<string, unknown>
  const adapter = ctx.registry.active

  switch (method) {
    case 'ping':
      return ok({ pong: true, ts: Date.now() })

    case 'workspaces.list': {
      if (!requireAdapter(adapter, fail)) return
      return ok(await adapter!.listWorkspaces())
    }

    case 'sessions.list': {
      if (!requireAdapter(adapter, fail)) return
      const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : undefined
      const tasks = await adapter!.listSessions(workspaceId)
      return ok(mergeMeta(ctx, tasks))
    }

    case 'session.history': {
      if (!requireAdapter(adapter, fail)) return
      if (typeof p.sessionId !== 'string') return fail('bad-request', '缺 sessionId')
      return ok(await adapter!.history(p.sessionId))
    }

    case 'meta.get': {
      if (typeof p.sessionId !== 'string') return fail('bad-request', '缺 sessionId')
      return ok(ctx.meta.get(p.sessionId))
    }

    case 'meta.set': {
      if (typeof p.sessionId !== 'string') return fail('bad-request', '缺 sessionId')
      const patch = (p.patch ?? {}) as TaskMeta
      const next = ctx.meta.set(p.sessionId, patch)
      ctx.registry.notifyIndexChanged()
      return ok(next)
    }

    case 'send': {
      if (!requireAdapter(adapter, fail)) return
      if (typeof adapter?.sendText !== 'function') return fail('not-implemented', '该 harness 不支持发送')
      if (typeof p.sessionId !== 'string' || typeof p.text !== 'string') return fail('bad-request', '参数不全')
      await adapter.sendText(p.sessionId, p.text)
      return ok({ sent: true })
    }

    case 'stop': {
      if (!requireAdapter(adapter, fail)) return
      if (typeof adapter?.stopSession !== 'function') return fail('not-implemented', '该 harness 不支持停止')
      if (typeof p.sessionId !== 'string') return fail('bad-request', '缺 sessionId')
      await adapter.stopSession(p.sessionId)
      return ok({ stopped: true })
    }

    case 'resolve': {
      if (!requireAdapter(adapter, fail)) return
      if (typeof adapter?.resolveInteraction !== 'function') return fail('not-implemented', '该 harness 不支持审批')
      if (typeof p.sessionId !== 'string' || typeof p.interactionId !== 'string')
        return fail('bad-request', '参数不全')
      const outcome = p.outcome === 'reject' ? 'reject' : 'approve'
      await adapter.resolveInteraction(p.sessionId, p.interactionId, outcome)
      return ok({ resolved: true })
    }

    default:
      return fail('unknown-method', method)
  }
}

function requireAdapter(
  adapter: HarnessAdapter | null,
  fail: (code: string, message: string) => void,
): boolean {
  if (!adapter || !adapter.isReady()) {
    fail('adapter-unavailable', 'harness 适配器未就绪')
    return false
  }
  return true
}

// ---------- 订阅路由 ----------

function handleSub(
  ws: WebSocket,
  ctx: WsCtx,
  subs: Map<string, SubEntry>,
  frame: Extract<ClientFrame, { t: 'sub' }>,
): void {
  const old = subs.get(frame.id)
  old?.cleanup?.()

  if (frame.topic === 'sessions-index') {
    const includeArchived = frame.params?.includeArchived === true
    let stop = () => {}
    const push = () => {
      void buildIndex(ctx, includeArchived)
        .then((data) => send(ws, { t: 'push', sub: frame.id, kind: 'replace', data }))
        .catch((e) => warn('sessions-index 快照失败', String(e)))
    }
    push()
    const off = ctx.registry.onIndexChanged(push)
    stop = off
    subs.set(frame.id, { topic: frame.topic, params: frame.params, cleanup: stop })
    return
  }

  if (frame.topic === 'session-stream') {
    const sessionId = frame.params?.sessionId
    if (!sessionId) return
    const adapter = ctx.registry.active
    if (!adapter || !adapter.isReady()) {
      send(ws, { t: 'push', sub: frame.id, kind: 'end', data: { error: 'adapter-unavailable' } })
      return
    }
    const cleanups: (() => void)[] = []
    // 先回快照再挂实时流
    void adapter
      .history(sessionId)
      .then((events) => {
        if (ws.readyState !== ws.OPEN) return
        send(ws, { t: 'push', sub: frame.id, kind: 'snapshot', data: { sessionId, events } })
        const live = adapter.subscribe(sessionId, (f) => {
          send(ws, { t: 'push', sub: frame.id, kind: f.kind, data: { sessionId, ...f } })
        })
        cleanups.push(live)
      })
      .catch((e) => {
        warn('session-stream 快照失败', String(e))
        send(ws, { t: 'push', sub: frame.id, kind: 'end', data: { sessionId, error: String(e) } })
      })
    subs.set(frame.id, { topic: frame.topic, params: frame.params, cleanup: () => cleanups.forEach((c) => c()) })
    return
  }

  send(ws, { t: 'res', id: '', ok: false, error: { code: 'bad-topic', message: `未知订阅 ${frame.topic}` } })
}

// ---------- 索引快照 ----------

export interface SessionsIndex {
  ready: boolean
  adapterId: string | null
  workspaces: Workspace[]
  tasks: TaskSummary[]
}

async function buildIndex(ctx: WsCtx, includeArchived: boolean): Promise<SessionsIndex> {
  const adapter = ctx.registry.active
  if (!adapter || !adapter.isReady()) {
    return { ready: false, adapterId: adapter?.id ?? null, workspaces: [], tasks: [] }
  }
  const [workspaces, tasks] = await Promise.all([adapter.listWorkspaces(), adapter.listSessions()])
  const merged = mergeMeta(ctx, tasks).filter((t) => includeArchived || !t.archived)
  merged.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return { ready: true, adapterId: adapter.id, workspaces, tasks: merged }
}

function mergeMeta(ctx: WsCtx, tasks: TaskSummary[]): TaskSummary[] {
  return tasks.map((t) => {
    const m = ctx.meta.get(t.id)
    return {
      ...t,
      pinned: m.pinned,
      archived: m.archived,
      unread: m.unread,
      alias: m.alias,
    }
  })
}
