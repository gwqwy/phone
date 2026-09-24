/**
 * 中继数据帧的内容解析。
 *
 * 帧里的消息会以三种形态出现，三种都要认：
 *   - 顶层直接是 JSON 对象（官方最常见）；
 *   - `payload.kind === 'binary'`：整段 base64；
 *   - `payload.kind === 'fragment'`：按 logicalFrameId 分片，需要重组后再解 JSON。
 *
 * 解析器对深度的容忍度有限（8 层）：官方会把 delta 套在 frame.payload.deltas 里，
 * 但再深的嵌套只会是业务数据，继续往下找只会误伤。
 */

import { base64Decode } from './crypto.js'
import { basename, phaseFromStatus } from './session-index.js'

const MAX_DEPTH = 8
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** bootstrap 的结果是整表替换，其余请求（workspace-list 等）是增量 upsert。 */
export function isBootstrapResult(requestId) {
  return String(requestId ?? '').startsWith('bootstrap')
}

/**
 * 把帧文本解成 JSON；认不出返回 null。
 * SSE 的 `data: {...}` 与 HTML 都要拒绝——它们在关闭页面上很常见，混进来会污染状态。
 */
export function parseFrameText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<')) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const candidate = trimmed.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

/**
 * 分片重组器：按 logicalFrameId 攒**字节**，拼齐后一次性解码。
 *
 * 必须攒字节而不是攒解码后的字符串——一个多字节字符完全可能被切在两个字片之间，
 * 逐片解码会把字符拆坏（实测得到过 '中斀ǦՋ试' 这种结果）。
 */
export class FragmentAssembler {
  constructor() {
    this.slots = new Map()
  }

  /**
   * @returns {string|null} 组装完成时返回完整文本，否则 null
   */
  accept({ logicalFrameId, fragmentIndex, fragmentCount, dataBase64 }) {
    if (!logicalFrameId || typeof fragmentCount !== 'number') return null
    if (this.slots.size > 32 && !this.slots.has(logicalFrameId)) this.slots.clear()

    let slot = this.slots.get(logicalFrameId)
    if (!slot) {
      slot = { parts: new Map(), count: fragmentCount, bytes: 0 }
      this.slots.set(logicalFrameId, slot)
    }
    if (slot.parts.has(fragmentIndex)) return null

    let chunk
    try {
      chunk = base64Decode(dataBase64)
    } catch {
      this.slots.delete(logicalFrameId)
      return null
    }
    slot.parts.set(fragmentIndex, chunk)
    slot.bytes += chunk.length
    if (slot.bytes > MAX_FRAME_BYTES) {
      this.slots.delete(logicalFrameId)
      return null
    }
    if (slot.parts.size < slot.count) return null

    const joined = new Uint8Array(slot.bytes)
    let offset = 0
    for (let i = 0; i < slot.count; i++) {
      const part = slot.parts.get(i)
      if (part === undefined) return null
      joined.set(part, offset)
      offset += part.length
    }
    this.slots.delete(logicalFrameId)
    return utf8DecodeBytes(joined)
  }
}

function utf8DecodeBytes(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i++]
    if (byte < 0x80) out += String.fromCharCode(byte)
    else if (byte < 0xe0) out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i++] & 0x3f))
    else if (byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      )
    } else {
      const code =
        ((byte & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
      const v = code - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
  }
  return out
}

/**
 * 深度受限的遍历：对每个节点调用 visit，visit 返回 true（命中）即停止。
 * 返回命中的节点。
 */
function findNode(root, visit, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH || root === null || typeof root !== 'object') return null
  if (seen.has(root)) return null
  seen.add(root)
  if (Array.isArray(root)) {
    for (const item of root) {
      const hit = findNode(item, visit, depth + 1, seen)
      if (hit) return hit
    }
    return null
  }
  const hit = visit(root)
  if (hit) return root
  for (const key of Object.keys(root)) {
    const child = findNode(root[key], visit, depth + 1, seen)
    if (child) return child
  }
  return null
}

const SESSION_STATES = new Set([
  'created',
  'prompt_sent',
  'resumed',
  'streaming',
  'permission_request',
  'permission_resolved',
  'elicitation_request',
  'elicitation_resolved',
  'updated',
  'completed',
  'error',
])

/** 事件白名单：认不出的名字一律忽略——协议新增时先补进这里再谈展示。 */
export function isKnownEventName(name) {
  return SESSION_STATES.has(String(name ?? ''))
}

/** 从任意嵌套里找出 topic 帧的信封。 */
export function findTopicFrame(root) {
  return findNode(root, (node) => typeof node.topic === 'string' && 'payload' in node)
}

/** 从任意嵌套里找出 `zcode_type` 信封。 */
export function findEnvelope(root) {
  return findNode(root, (node) => typeof node.zcode_type === 'string')
}

/**
 * 会话索引 delta。
 *
 * `topic` 必须传进来：会话对象自己不带工作区，工作区信息在主题路径里
 * （`sessions-index/<workspaceKey>`），不带主题就只能显示成空。
 *
 * @returns {{upserts:Array<object>, removes:string[]}}
 */
export function parseSessionDeltas(payload, topic = '') {
  const out = { upserts: [], removes: [] }
  if (!payload || typeof payload !== 'object') return out
  // 主题路径里带的是**完整工作区键**（`sessions-index/W:\ws\demo`），
  // 打开桥接时必须用这个原值，不能用它的 basename——用 basename 会被桌面端拒绝，
  // 表现为"连上了但读不到会话内容"。
  const topicKey = String(topic).replace(/^sessions-index\/?/, '')
  const topicWorkspace = basename(topicKey)

  if (payload.kind === 'snapshot' && Array.isArray(payload.snapshot?.sessions)) {
    for (const raw of payload.snapshot.sessions) {
      const session = sessionFromWire(raw, topicWorkspace, topicKey)
      if (session) out.upserts.push(session)
    }
    return out
  }

  const deltas = Array.isArray(payload.deltas) ? payload.deltas : []
  for (const delta of deltas) {
    if (!delta || typeof delta !== 'object') continue
    if (delta.op === 'session.removed' && delta.sessionId) {
      out.removes.push(delta.sessionId)
      continue
    }
    const session = sessionFromWire(delta.session ?? delta, topicWorkspace, topicKey)
    if (session) out.upserts.push(session)
  }
  return out
}

function sessionFromWire(raw, topicWorkspace = '', topicKey = '') {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = raw.sessionId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const summary = raw.pendingInteractionSummary ?? {}
  const interaction = raw.pendingInteraction ?? {}
  return {
    sessionId,
    title: typeof raw.title === 'string' ? raw.title : '',
    phase: typeof raw.phase === 'string' ? raw.phase : null,
    sessionEnded: raw.sessionEnded === true,
    permissionCount: numberOr(summary.permissionCount, 0),
    userInputCount: numberOr(summary.userInputCount, 0),
    interactionKind: interaction.kind ?? '',
    toolName: interaction.toolName ?? '',
    description: interaction.description ?? interaction.summary ?? '',
    lastActivityAt: numberOr(raw.lastActivityAt, null),
    createdAt: numberOr(raw.createdAt, null),
    workspace: basename(raw.workspaceId ?? '') || topicWorkspace,
    workspaceKey: raw.workspaceKey ?? raw.workspaceId ?? topicKey,
  }
}

/**
 * 任务索引 delta。
 * @returns {{upserts:Array<object>, removes:string[], archived:string[]}}
 */
export function parseTaskDeltas(payload) {
  const out = { upserts: [], removes: [], archived: [] }
  if (!payload || typeof payload !== 'object') return out

  if (payload.kind === 'snapshot' && Array.isArray(payload.snapshot?.tasks)) {
    for (const raw of payload.snapshot.tasks) {
      const task = taskFromWire(raw)
      if (task) out.upserts.push(task)
    }
    return out
  }

  const deltas = Array.isArray(payload.deltas) ? payload.deltas : []
  for (const delta of deltas) {
    if (!delta || typeof delta !== 'object') continue
    if (delta.op === 'task.removed') {
      const id = delta.address?.taskId ?? delta.taskId
      if (id) out.removes.push(id)
      continue
    }
    const task = taskFromWire(delta.task ?? delta)
    if (!task) continue
    if (task.archived) {
      // 归档在列表上等同于"这条不见了"，否则归档任务会一直挂在列表里。
      out.archived.push(task.sessionId)
      continue
    }
    out.upserts.push(task)
  }
  return out
}

function taskFromWire(raw) {
  if (!raw || typeof raw !== 'object') return null
  const address = raw.address ?? {}
  const meta = raw.meta ?? {}
  const membership = raw.membership ?? {}
  const activity = raw.activity ?? {}
  const sessionId = address.taskId ?? meta.taskId ?? raw.taskId
  if (typeof sessionId !== 'string' || !sessionId) return null
  const workspaceKey = address.workspacePath ?? meta.workspacePath ?? raw.workspacePath ?? ''
  return {
    sessionId,
    title: meta.title ?? raw.title ?? '',
    workspace: basename(workspaceKey),
    workspaceKey,
    phase: activity.phase ?? raw.liveStatus ?? phaseFromStatus(meta.status),
    lastActivityAt: numberOr(activity.lastActivityAt ?? meta.updatedAt ?? raw.updatedAt, null),
    createdAt: numberOr(meta.createdAt ?? raw.createdAt, null),
    pinned: Boolean(membership.pinned),
    archived: Boolean(membership.archived),
  }
}

/** 扁平任务视图：bootstrap / workspace-list 的 `result.tasks` 就是这种形状。 */
export function parseFlatTasks(result) {
  const list = Array.isArray(result?.tasks) ? result.tasks : Array.isArray(result) ? result : []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const sessionId = raw.taskId
    if (typeof sessionId !== 'string' || !sessionId) continue
    out.push({
      sessionId,
      title: raw.title ?? '',
      workspace: raw.workspaceLabel || basename(raw.workspacePath ?? ''),
      workspaceKey: raw.workspacePath ?? '',
      phase: phaseFromStatus(raw.displayStatus) ?? raw.displayStatus ?? null,
      lastActivityAt: numberOr(raw.updatedAt, null),
      createdAt: numberOr(raw.createdAt, null),
    })
  }
  return out
}

/**
 * 工作区列表。
 *
 * `workspace-list-response.result` 里除了 `tasks` 还有一个**独立的 `workspaces` 数组**，
 * 它是"窗口里有哪些工作区"的权威来源，而重连/桥接要的键大概率出自这里——
 * 任务里的 `workspacePath` 只是任务归属的路径，两者未必是同一个东西。
 *
 * 字段名没有公开文档，所以按候选名单依次取：拿到哪个用哪个，并在诊断日志里
 * 保留原始条目，下一次真机反馈就能确认真正的键叫什么。
 */
const WORKSPACE_KEY_FIELDS = ['workspaceKey', 'key', 'workspacePath', 'path', 'rootPath', 'folderPath', 'id']
const WORKSPACE_LABEL_FIELDS = ['workspaceLabel', 'label', 'name', 'title', 'displayName']

export function parseWorkspaces(result) {
  const list = Array.isArray(result) ? result : Array.isArray(result?.workspaces) ? result.workspaces : []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      if (typeof raw === 'string') out.push({ key: raw, label: basename(raw), raw })
      continue
    }
    const key = pickString(raw, WORKSPACE_KEY_FIELDS)
    if (!key) continue
    out.push({
      key,
      label: pickString(raw, WORKSPACE_LABEL_FIELDS) || basename(key),
      kind: raw.workspaceKind ?? raw.kind ?? '',
      raw,
    })
  }
  return out
}

function pickString(object, fields) {
  for (const field of fields) {
    const value = object[field]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * 在权威工作区列表里找出与某个路径/标签对应的工作区键。
 * 找不到就返回空串，让调用方退回任务里的路径。
 */
export function workspaceKeyFor(workspaces, { workspaceKey = '', workspace = '' } = {}) {
  if (!Array.isArray(workspaces) || !workspaces.length) return ''
  const wanted = [workspaceKey, workspace].filter(Boolean)
  for (const candidate of wanted) {
    const hit = workspaces.find((item) => item.key === candidate || item.label === candidate)
    if (hit) return hit.key
  }
  // 路径归一化后再比一次：大小写与尾部分隔符在 Windows 上不值得让用户付出代价。
  const normalize = (text) => String(text).replace(/[\\/]+$/, '').toLowerCase()
  for (const candidate of wanted) {
    const hit = workspaces.find((item) => normalize(item.key) === normalize(candidate))
    if (hit) return hit.key
  }
  return ''
}

function numberOr(value, fallback) {
  return typeof value === 'number' && isFinite(value) ? value : fallback
}
