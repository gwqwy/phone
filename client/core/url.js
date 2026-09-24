/**
 * 极简 URL 解析与查询串构造。
 *
 * 不依赖 WHATWG `URL` / `URLSearchParams`：小程序端没有这两个全局对象，
 * 而配对链接的解析必须在所有端上给出完全一致的结果，所以自己实现。
 */

const LINK_RE = /^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/

/** 查询串解码：与浏览器一致，`+` 视作空格。 */
export function decodeComponent(text) {
  const plusDecoded = String(text).replace(/\+/g, ' ')
  try {
    return decodeURIComponent(plusDecoded)
  } catch {
    return plusDecoded
  }
}

/** 查询串编码：不用 `+` 表示空格，避免解码端语义分歧。 */
export function encodeComponent(text) {
  return encodeURIComponent(String(text)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * 解析 http(s) 链接。
 *
 * @returns {{scheme:string,userinfo:string,host:string,port:number|null,path:string,
 *            query:Array<[string,string]>, authority:string}|null}
 *   `port` 为 null 表示链接没写端口（重建时必须保持"没写"的状态，否则
 *   会把 `https://host/...` 变成 `https://host:443/...`，与桌面端签发的链接不一致）。
 */
export function parseLink(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  const m = LINK_RE.exec(text)
  if (!m) return null

  const scheme = m[1].toLowerCase()
  let authority = m[2]
  if (!authority) return null

  let userinfo = ''
  const at = authority.lastIndexOf('@')
  if (at >= 0) {
    userinfo = authority.slice(0, at)
    authority = authority.slice(at + 1)
  }

  let host = authority
  let port = null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end < 0) return null
    host = authority.slice(0, end + 1)
    const rest = authority.slice(end + 1)
    if (rest.startsWith(':')) port = toPort(rest.slice(1))
  } else {
    const colon = authority.lastIndexOf(':')
    if (colon >= 0) {
      host = authority.slice(0, colon)
      port = toPort(authority.slice(colon + 1))
    }
  }
  if (!host) return null

  const query = []
  if (m[4]) {
    for (const pair of m[4].split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = eq < 0 ? pair : pair.slice(0, eq)
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      query.push([decodeComponent(key), decodeComponent(value)])
    }
  }

  return { scheme, userinfo, host, port, path: m[3] || '', query, authority: m[2] }
}

function toPort(text) {
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return value >= 0 && value <= 65535 ? value : null
}

/** 用解析结果重建链接；`params` 为有序键值对数组。 */
export function buildLink(parsed, params) {
  const authority = parsed.userinfo ? `${parsed.userinfo}@${parsed.authority}` : parsed.authority
  let out = `${parsed.scheme}://${authority}${parsed.path || ''}`
  const pairs = params.filter(([k, v]) => k !== '' && v !== '')
  if (pairs.length) {
    out += '?' + pairs.map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`).join('&')
  }
  return out
}

/** 有序键值对 → 普通对象（后出现的键覆盖先出现的，与浏览器一致）。 */
export function toParamsObject(pairs) {
  const out = {}
  for (const [k, v] of pairs) out[k] = v
  return out
}

/** 普通对象 → 有序键值对（保持插入顺序）。 */
export function toParamsArray(params) {
  return Object.keys(params ?? {}).map((k) => [k, String(params[k])])
}

/**
 * 判定主机是否为环回 / 私有 / 保留地址。
 *
 * 用于两类场景，语义完全不同，调用方必须自己分清：
 *   - 服务端主动发起请求时：来自请求体的 URL 必须先过这里，命中即拒绝（防 SSRF）。
 *   - 手机端连接用户自己配置的设备时：这些地址正是常态（本机 dsh 就是 127.0.0.1），
 *     属于显式信任路径，不应拒绝。
 */
export function isPrivateOrReservedHost(host) {
  const name = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!name) return true
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name.endsWith('.local') || name.endsWith('.internal')) return true

  if (name.includes(':')) {
    // IPv6：环回、未指定、link-local、ULA、IPv4-mapped
    if (name === '::' || name === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(name)) return true
    if (/^fe[89ab][0-9a-f]:/.test(name)) return true
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(name)
    return mapped ? isPrivateOrReservedHost(mapped[1]) : false
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (!v4) return false
  const octets = v4.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return true
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0/24 协议保留
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播与保留
  return false
}
