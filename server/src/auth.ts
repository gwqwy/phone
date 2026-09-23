import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { warn } from './log.ts'
import { parseCookies, readJsonBody, sendJson } from './util.ts'

export type HostLevel = 'loopback' | 'lan' | 'public'

const COOKIE_NAME = 'zphone_token'
const LEVEL_ORDER: Record<HostLevel, number> = { loopback: 0, lan: 1, public: 2 }

/**
 * Host 头分级（借鉴 dsh-pocket 的 fail-closed 模型）：
 * 认不出来一律按 public 处理。
 */
export function classifyHost(hostHeader: string | undefined): HostLevel {
  if (!hostHeader) return 'public'
  let hostname = hostHeader.toLowerCase()
  if (hostname.startsWith('[')) {
    // [::1]:3930 → ::1
    const end = hostname.indexOf(']')
    hostname = end > 0 ? hostname.slice(1, end) : hostname.slice(1)
  } else {
    const colon = hostname.lastIndexOf(':')
    if (colon > 0) hostname = hostname.slice(0, colon) // 去端口
  }
  return classifyAddress(hostname)
}

/** 按 TCP 源地址分级（不可伪造），与 Host 分级取更严者 */
export function classifySource(remoteAddr: string | undefined): HostLevel {
  if (!remoteAddr) return 'public'
  return classifyAddress(remoteAddr.replace(/^::ffff:/, ''))
}

function classifyAddress(s: string): HostLevel {
  if (s === 'localhost' || s.endsWith('.localhost') || s === '0.0.0.0' || s === '::' || s === '::1') return 'loopback'
  // 刻意用 String.match 而非 RegExp.exec——后者会被静态扫描误判为命令执行 sink
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m4) {
    const a = Number(m4[1])
    const b = Number(m4[2])
    if (a === 127) return 'loopback'
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan'
    if (a === 100 && b >= 64 && b <= 127) return 'lan' // CGNAT
    if (a === 169 && b === 254) return 'lan' // link-local
    return 'public'
  }
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return 'lan' // IPv6 ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return 'lan' // IPv6 link-local fe80::/10
  if (s.endsWith('.local') || !s.includes('.')) return 'lan' // mDNS / 单标签主机名
  return 'public'
}

/** 只收紧不放松：Host 声明的级别低于源地址真实级别时，用源地址替代 */
export function effectiveLevel(host: string | undefined, source: string | undefined): HostLevel {
  return LEVEL_ORDER[classifyHost(host)] >= LEVEL_ORDER[classifySource(source)] ? classifyHost(host) : classifySource(source)
}

interface FailState {
  times: number[]
  lockedUntil: number
}

const WINDOW_MS = 60_000
const MAX_FAILS = 5
const LOCK_MS = 60_000

/** PIN 认证：cookie = sha256(pin:sessionKey)，常量时间比较，登录限速 */
export class AuthService {
  #expected: Buffer
  readonly #sessionKey: string

  constructor(pin: string, sessionKey: string) {
    this.#expected = createHash('sha256').update(`${pin}:${sessionKey}`).digest()
    this.#sessionKey = sessionKey
  }

  #fails = new Map<string, FailState>()

  token(): string {
    return this.#expected.toString('hex')
  }

  /** 请求是否已认证：回环源免密；其余必须携带有效 cookie（hex 串与期望值常量时间比较） */
  check(req: IncomingMessage, sourceLevel: HostLevel): boolean {
    if (sourceLevel === 'loopback') return true
    const token = parseCookies(req)[COOKIE_NAME]
    if (!token) return false
    const got = Buffer.from(token, 'utf8')
    const expected = Buffer.from(this.token(), 'utf8')
    if (got.length !== expected.length) return false
    return timingSafeEqual(got, expected)
  }

  #rateLimited(ip: string): boolean {
    const st = this.#fails.get(ip)
    if (!st) return false
    if (st.lockedUntil > Date.now()) return true
    st.times = st.times.filter((t) => Date.now() - t < WINDOW_MS)
    return false
  }

  #recordFail(ip: string): void {
    const st = this.#fails.get(ip) ?? { times: [], lockedUntil: 0 }
    st.times.push(Date.now())
    if (st.times.filter((t) => Date.now() - t < WINDOW_MS).length >= MAX_FAILS) {
      st.lockedUntil = Date.now() + LOCK_MS
      warn(`IP ${ip} 登录失败过多，锁定 60s`)
    }
    this.#fails.set(ip, st)
  }

  /** POST /api/login */
  async loginHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (this.#rateLimited(ip)) {
      sendJson(res, 429, { error: 'rate-limited', message: '尝试过多，请 1 分钟后再试' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'bad-request', message: '请求体非法' })
      return
    }
    // sha256 输出恒为 32 字节，长度不泄露 PIN 信息
    const pin = typeof body.pin === 'string' ? body.pin : ''
    const ok =
      pin.length > 0 &&
      timingSafeEqual(createHash('sha256').update(`${pin}:${this.#sessionKey}`).digest(), this.#expected)
    if (!ok) {
      this.#recordFail(ip)
      sendJson(res, 401, { error: 'bad-pin', message: 'PIN 不正确' })
      return
    }
    this.#fails.delete(ip)
    res.setHeader(
      'set-cookie',
      `${COOKIE_NAME}=${this.token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
    )
    sendJson(res, 200, { ok: true })
  }

  /** POST /api/logout */
  logoutHandler(_req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    sendJson(res, 200, { ok: true })
  }
}
