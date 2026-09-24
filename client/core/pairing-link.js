/**
 * 配对链接的解析与重建。
 *
 * 链接就是普通的 http(s) URL 加查询参数，桌面端「移动端远程控制」出示的二维码内容
 * 即此。语义来自官方 remote/v4 前端：sid→deviceSid、hash→passHash、t→timestamp(ms)、
 * mid→deviceMid、name→deviceName、app_version→appVersion。
 *
 * 三条必须守住的规则（否则用户会遇到"明明扫对了却连不上"）：
 *   1. 只接受 http/https，且必须能解析出主机；
 *   2. sid 与 hash 都必须非空；
 *   3. 每次使用前重铸 t（毫秒时间戳）——桌面端据此判断链接新鲜度，
 *      这也是"刷新"按钮的语义。
 */

import { buildLink, parseLink, toParamsArray, toParamsObject } from './url.js'

export const SID_KEY = 'sid'
export const HASH_KEY = 'hash'
export const T_KEY = 't'
export const NAME_KEY = 'name'

export const ENDPOINT_KIND_RELAY = 'zcode-relay'

/**
 * 解析配对链接为端点记录。
 *
 * @param {string} input 粘贴或扫码得到的文本
 * @param {{id?:string, now?:number}} [options]
 * @returns {object|null} 解析失败返回 null，调用方负责给出提示
 */
export function parsePairingLink(input, options = {}) {
  const parsed = parseLink(input)
  if (!parsed) return null
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return null
  if (!parsed.host) return null

  const params = toParamsObject(parsed.query.filter(([k, v]) => k !== '' && v !== ''))
  const sid = params[SID_KEY]
  const hash = params[HASH_KEY]
  if (!sid || !hash) return null

  const baseUrl = buildLink({ ...parsed, query: [] }, [])
  return {
    id: options.id ?? newId(),
    kind: ENDPOINT_KIND_RELAY,
    baseUrl,
    params,
    label: params[NAME_KEY] ?? '',
    createdAt: options.now ?? Date.now(),
  }
}

/**
 * 用当前时间重铸链接。除 t 以外的参数一律原样透传——官方页面就是这么做的，
 * 认不出的参数也必须保留，否则桌面端将来新增的字段会被我们吃掉。
 */
export function buildPairingUrl(endpoint, now = Date.now()) {
  const parsed = parseLink(endpoint?.baseUrl)
  if (!parsed) return ''
  const params = endpoint.params ?? {}
  const pairs = toParamsArray(params).filter(([k]) => k !== T_KEY)
  pairs.push([T_KEY, String(now)])
  return buildLink({ ...parsed, query: [] }, pairs)
}

/** 配对标识的展示后缀：链接过期重新导入时，用户靠它确认换的是同一台设备。 */
export function sidSuffix(sid, length = 6) {
  const text = String(sid ?? '')
  return text.length <= length ? text : text.slice(-length)
}

/** 端点是否具备可用的配对凭据（用来在列表上区分"未配对完整"的卡片）。 */
export function isPaired(endpoint) {
  const params = endpoint?.params ?? {}
  return Boolean(params[SID_KEY] && params[HASH_KEY] && endpoint?.baseUrl)
}

function newId() {
  return 'ep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}
