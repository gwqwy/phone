/**
 * DeepSeek Harness 端点的地址解析。
 *
 * dsh 端点与 ZCode 中继端点完全不同：它不是协议对接，而是把一个**已经存在的 dsh 界面**
 * 装进面板里。地址有三种来源，行为差别很大，必须在导入时就分清楚：
 *
 *   - 本机（local）：手机自己跑的 dsh（Termux + Node），`127.0.0.1:3080`。免密码。
 *   - 局域网（lan）：电脑上的 dsh 经 dsh-pocket 代理暴露在 `http://<电脑IP>:3081`，
 *     要输 dsh-pocket 的局域网密码。
 *   - 公网（public）：dsh-pocket 的 Cloudflare 隧道地址（或命名隧道的固定域名），
 *     一律要密码。安全性完全取决于那个域名背后的电脑，导入时必须让用户看清这一点。
 *
 * 导入时把 `?token=` 取出来单独存（PIN），这样重建链接时可以按需决定是否带上它。
 */

import { parseLink, buildLink, isPrivateOrReservedHost } from './url.js'

export const ENDPOINT_KIND_DSH = 'dsh-panel'

export const ORIGIN_LOCAL = 'local'
export const ORIGIN_LAN = 'lan'
export const ORIGIN_PUBLIC = 'public'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** 地址来源分级。用于提示文案与「是否需要密码」的默认判断。 */
export function classifyOrigin(host) {
  const name = String(host ?? '').toLowerCase()
  if (LOOPBACK_HOSTS.has(name)) return ORIGIN_LOCAL
  if (/^127\./.test(name)) return ORIGIN_LOCAL
  if (isPrivateOrReservedHost(name)) return ORIGIN_LAN
  return ORIGIN_PUBLIC
}

/**
 * 解析 dsh 地址。
 *
 * @param {string} input 扫码或粘贴得到的内容
 * @param {{id?:string, now?:number, source?:string}} [options]
 * @returns {object|null}
 */
export function parseDshLink(input, options = {}) {
  const parsed = parseLink(input)
  if (!parsed) return null
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return null
  if (!parsed.host) return null

  const params = {}
  let pin = ''
  for (const [k, v] of parsed.query) {
    if (k === 'token' && v) {
      pin = v
      continue
    }
    if (k !== '' && v !== '') params[k] = v
  }

  const base = buildLink({ ...parsed, query: [] }, [])
  const origin = classifyOrigin(parsed.host)
  return {
    id: options.id ?? newId(),
    kind: ENDPOINT_KIND_DSH,
    baseUrl: base,
    params,
    pin,
    origin,
    label: params.name ?? labelFor(parsed, origin),
    createdAt: options.now ?? Date.now(),
  }
}

/**
 * 重建 dsh 地址。
 *
 * `withPin` 默认 true：dsh-pocket 的 `?token=` 是一次性的入口凭据，带上它可以省掉
 * 一次登录页跳转。用户主动选「清除密码」时传 false。
 */
export function buildDshUrl(endpoint, { withPin = true } = {}) {
  const parsed = parseLink(endpoint?.baseUrl)
  if (!parsed) return ''
  const pairs = Object.keys(endpoint.params ?? {}).map((k) => [k, String(endpoint.params[k])])
  if (withPin && endpoint.pin) pairs.push(['token', String(endpoint.pin)])
  return buildLink({ ...parsed, query: [] }, pairs)
}

/** 同一台 dsh 的判定键：来源分级 + 完整地址（含端口与路径）。 */
export function dshIdentity(endpoint) {
  const parsed = parseLink(endpoint?.baseUrl)
  if (!parsed) return ''
  const port = parsed.port === null ? '' : `:${parsed.port}`
  return `${parsed.host.toLowerCase()}${port}${parsed.path || '/'}`
}

function labelFor(parsed, origin) {
  const host = parsed.host.replace(/^\[|\]$/g, '')
  const port = parsed.port === null ? '' : `:${parsed.port}`
  if (origin === ORIGIN_LOCAL) return '本机 dsh'
  return `${host}${port}`
}

function newId() {
  return 'ep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}
