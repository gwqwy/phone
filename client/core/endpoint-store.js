/**
 * 端点仓库。
 *
 * 一次导入、长期可用——所以顺序、去重、换链接这三件事必须可靠：用户导入五六台设备之后，
 * 任何一次「重排/改名/换链接」都不允许把数据弄丢或弄乱。这里的规则全部有单测兜底。
 *
 * 存储布局（与上游 zremote 的语义一致，只是换成了 uni 的存储）：
 *   shou.endpoint.index   有序 id 数组，顺序就是用户看到的顺序
 *   shou.endpoint.<id>    单条端点记录
 *   shou.lastEndpoint     上次停留的端点 id，冷启动恢复用
 */

import { ENDPOINT_KIND_RELAY, parsePairingLink, sidSuffix } from './pairing-link.js'
import { ENDPOINT_KIND_DSH, dshIdentity, parseDshLink } from './dsh-link.js'

const KEY_INDEX = 'shou.endpoint.index'
const KEY_RECORD = (id) => `shou.endpoint.${id}`
const KEY_LAST = 'shou.lastEndpoint'

export function createEndpointStore(storage) {
  return new EndpointStore(storage)
}

export class EndpointStore {
  constructor(storage) {
    this.storage = storage
  }

  /** 有序端点列表；索引里指向已不存在记录的 id 会被静默跳过。 */
  list() {
    const ids = this.storage.get(KEY_INDEX) ?? []
    const out = []
    for (const id of ids) {
      const record = this.storage.get(KEY_RECORD(id))
      if (record && record.id) out.push(record)
    }
    return out
  }

  get(id) {
    if (!id) return null
    return this.storage.get(KEY_RECORD(id)) ?? null
  }

  /**
   * 导入一个新端点。
   *
   * 撞车时不报错而是把既有端点交回给界面——"这台设备你已经加过了，帮你切过去"
   * 比弹一个错误有用得多。要换掉某台设备的链接请走 `replaceLink`（它不做去重，
   * 因为新链接的 sid 往往和旧的相同）。
   *
   * @returns {{status:'added'|'duplicate'|'invalid', endpoint?:object, existing?:object}}
   */
  import(input, options = {}) {
    const relay = parsePairingLink(input, options)
    const endpoint = relay ?? parseDshLink(input, options)
    if (!endpoint) return { status: 'invalid' }

    const existing = this.findDuplicate(endpoint)
    if (existing) return { status: 'duplicate', existing }

    this.save(endpoint)
    this.appendOrder(endpoint.id)
    return { status: 'added', endpoint }
  }

  findDuplicate(candidate) {
    for (const item of this.list()) {
      if (item.kind !== candidate.kind) continue
      if (candidate.kind === ENDPOINT_KIND_RELAY) {
        const a = item.params?.sid
        const b = candidate.params?.sid
        if (a && b && a === b) return item
      } else if (candidate.kind === ENDPOINT_KIND_DSH) {
        if (dshIdentity(item) && dshIdentity(item) === dshIdentity(candidate)) return item
      }
    }
    return null
  }

  /**
   * 换链接：保留 id、创建时间与已有名字（除非原来没名字），位置不动。
   * 场景是桌面端重新签发了配对码，或 dsh-pocket 的隧道地址变了。
   */
  replaceLink(id, input, options = {}) {
    const current = this.get(id)
    if (!current) return null
    const parsed =
      current.kind === ENDPOINT_KIND_RELAY
        ? parsePairingLink(input, { ...options, id: current.id })
        : parseDshLink(input, { ...options, id: current.id })
    if (!parsed) return null

    const merged = {
      ...parsed,
      id: current.id,
      createdAt: current.createdAt,
      label: current.label ? current.label : parsed.label,
      // 换链接不该把用户此前记下的密码抹掉——新链接没带 token 时沿用旧的。
      pin: parsed.pin || current.pin || '',
    }
    this.save(merged)
    return merged
  }

  rename(id, label) {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current, label: String(label ?? '').trim() }
    this.save(next)
    return next
  }

  remove(id) {
    const current = this.get(id)
    if (!current) return false
    this.storage.remove(KEY_RECORD(id))
    const ids = (this.storage.get(KEY_INDEX) ?? []).filter((x) => x !== id)
    this.storage.set(KEY_INDEX, ids)
    if (this.storage.get(KEY_LAST) === id) this.storage.remove(KEY_LAST)
    return true
  }

  /**
   * 重排。
   *
   * 拒绝任何"丢 id / 多 id / 出现不存在的 id"的顺序：与其把用户的数据写坏，
   * 不如拒绝这次操作（调用方保持原顺序）。
   */
  reorder(nextIds) {
    const current = (this.storage.get(KEY_INDEX) ?? []).slice()
    if (!Array.isArray(nextIds) || nextIds.length !== current.length) return false
    const seen = new Set()
    for (const id of nextIds) {
      if (seen.has(id)) return false
      seen.add(id)
      if (!current.includes(id)) return false
    }
    this.storage.set(KEY_INDEX, nextIds.slice())
    return true
  }

  touchLast(id) {
    if (id) this.storage.set(KEY_LAST, id)
  }

  lastEndpointId() {
    return this.storage.get(KEY_LAST) ?? ''
  }

  /** 卡片副标题：ZCode 显示配对标识后缀，dsh 显示来源分级。 */
  describe(endpoint) {
    if (!endpoint) return ''
    if (endpoint.kind === ENDPOINT_KIND_RELAY) {
      const sid = endpoint.params?.sid ?? ''
      return sid ? `sid …${sidSuffix(sid)}` : '配对信息不完整'
    }
    const host = endpoint.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    return host
  }

  save(endpoint) {
    this.storage.set(KEY_RECORD(endpoint.id), endpoint)
  }

  appendOrder(id) {
    const ids = (this.storage.get(KEY_INDEX) ?? []).filter((x) => x !== id)
    ids.push(id)
    this.storage.set(KEY_INDEX, ids)
  }
}
