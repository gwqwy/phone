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

  // 回环开发来源的 CORS（HBuilderX dev 直连兜底）；公网/局域网来源一律不放行
  if (pathname.startsWith('/api/') && req.headers.origin) {
    const origin = String(req.headers.origin)
    try {
      const o = new URL(origin)
      if (o.protocol === 'http:' && (o.hostname === 'localhost' || o.hostname === '127.0.0.1' || o.hostname === '::1')) {
        res.setHeader('access-control-allow-origin', origin)
        res.setHeader('access-control-allow-credentials', 'true')
        res.setHeader('vary', 'origin')
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          })
          res.end()
          return
        }
      }
    } catch {
      // 非法 Origin 按无 CORS 处理
    }
  }

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
      message: '手机端尚未构建：用 HBuilderX 打开 client 目录，发行 → 网站 H5',
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
  const isHtml = file.endsWith('.html')
  const headers: Record<string, string> = {
    'content-type': mimeOf(file),
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  }
  if (!isHtml) {
    headers['content-length'] = String(stat.size)
    res.writeHead(200, headers)
    createReadStream(file).pipe(res)
    return
  }
  // HTML：注入 PWA 元数据（HBuilderX 项目保持纯净，托管层负责加壳）
  res.writeHead(200, headers)
  const body = createReadStream(file)
  let injected = false
  body.setEncoding('utf8')
  body.on('data', (chunk: string) => {
    if (!injected && chunk.includes('</head>')) {
      injected = true
      chunk = chunk.replace(
        '</head>',
        `<link rel="manifest" href="/static/manifest.webmanifest" /><meta name="theme-color" content="#101014" /><link rel="apple-touch-icon" href="/static/icons/icon-192.png" /><meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-capable" content="yes" /></head>`,
      )
    }
    res.write(chunk)
  })
  body.on('end', () => res.end())
  body.on('error', () => res.end())
}
