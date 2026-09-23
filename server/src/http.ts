import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthService } from './auth.ts'
import { effectiveLevel } from './auth.ts'
import type { AppConfig } from './config.ts'
import type { HarnessRegistry } from './core/harness.ts'
import { sendJson } from './util.ts'
import { mimeOf } from './util.ts'

export interface HttpCtx {
  config: AppConfig
  auth: AuthService
  registry: HarnessRegistry
  version: string
}

export function createHandler(
  ctx: HttpCtx,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    route(req, res, ctx).catch((e) => {
      try {
        sendJson(res, 500, { error: 'internal', message: String(e) })
      } catch {
        // 响应已发出
      }
    })
  }
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: HttpCtx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal')
  const pathname = decodeURIComponent(url.pathname)
  const level = effectiveLevel(req.headers.host, req.socket.remoteAddress)

  if (pathname === '/api/login' && req.method === 'POST') return ctx.auth.loginHandler(req, res)
  if (pathname === '/api/logout' && req.method === 'POST') return ctx.auth.logoutHandler(req, res)

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    if (!ctx.auth.check(req, level)) {
      sendJson(res, 401, { authRequired: true })
      return
    }
    sendJson(res, 200, { ok: true, server: ctx.version, adapters: ctx.registry.list() })
    return
  }

  if (pathname.startsWith('/api/')) {
    if (!ctx.auth.check(req, level)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    sendJson(res, 404, { error: 'not-found' })
    return
  }

  // 静态资源不设防（纯 UI 代码），数据保护在 /api 与 /ws 的认证层
  serveStatic(res, ctx.config.clientDist, pathname)
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  if (!existsSync(root)) {
    sendJson(res, 503, {
      error: 'client-not-built',
      message: '手机端尚未构建：npm --prefix client run build:h5',
    })
    return
  }
  let file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : pathname))
  if (!file.startsWith(path.normalize(root + path.sep)) && file !== path.normalize(root)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // hash 路由不需要 SPA fallback，但保留兜底
    file = path.join(root, 'index.html')
    if (!existsSync(file)) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
  }
  const stat = statSync(file)
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': stat.size,
    'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}
