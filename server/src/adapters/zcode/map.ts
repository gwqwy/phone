import type { EventKind, EventStatus, TimelineEvent } from '../../protocol.ts'

/** session/read 返回的 MessageWithParts（apps/zcode-cli contracts session-store.port.ts） */
export interface ZcodePart {
  id?: string
  type?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  callID?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string; title?: string; error?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
  time?: { start?: number; end?: number; created?: number }
  files?: string[]
  attempt?: number
  prompt?: string
  description?: string
  agent?: string
  reason?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface ZcodeMessageInfo {
  id?: string
  role?: 'user' | 'assistant'
  time?: { created?: number; completed?: number }
  error?: { message?: string } | null
  modelId?: string
  providerId?: string
  [key: string]: unknown
}

export interface ZcodeMessageWithParts {
  info?: ZcodeMessageInfo
  parts?: ZcodePart[]
}

const TERMINAL_TOOLS = new Set(['bash', 'terminal', 'shell', 'command', 'Bash'])
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'replace', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function ts(ms: number | undefined): string {
  if (typeof ms === 'number' && Number.isFinite(ms)) {
    // 协议时间戳为 epoch 毫秒
    return new Date(ms < 1e12 ? ms * 1000 : ms).toISOString()
  }
  return new Date().toISOString()
}

function inputText(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url']) {
    const v = input[key]
    if (typeof v === 'string') return v
  }
  const s = JSON.stringify(input)
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

function toolKind(tool: string): EventKind {
  const t = tool.toLowerCase()
  if (TERMINAL_TOOLS.has(tool) || TERMINAL_TOOLS.has(t)) return 'terminal'
  if (EDIT_TOOLS.has(tool) || t === 'edit' || t === 'write') return 'edit'
  return 'tool'
}

/** 把一个 part 映射为时间线事件；返回 null 表示不展示 */
export function partToEvent(part: ZcodePart, msgId: string, role: string, fallbackTs: string): TimelineEvent | null {
  const id = typeof part.id === 'string' ? part.id : `${msgId}:${String(part.type ?? 'p')}`
  const type = part.type

  if (type === 'text') {
    if (part.ignored || part.synthetic) return null
    if (!part.text?.trim()) return null
    return { id, kind: role === 'user' ? 'user' : 'text', ts: ts(part.time?.start ?? fallbackTsMs(fallbackTs)), text: part.text }
  }

  if (role === 'user') return null // 用户消息里的附件等不展示

  if (type === 'reasoning') {
    const dur = part.time?.start !== undefined && part.time?.end !== undefined ? Math.round((part.time.end - part.time.start) / 100) / 10 : undefined
    return {
      id,
      kind: 'think',
      ts: ts(part.time?.start ?? fallbackTsMs(fallbackTs)),
      text: part.text ?? '',
      meta: dur !== undefined ? { durationSec: dur } : undefined,
    }
  }

  if (type === 'tool') {
    const tool = part.tool ?? 'tool'
    const state = part.state ?? {}
    const status = (state.status as EventStatus | undefined) ?? 'pending'
    const kind = toolKind(tool)
    const meta: Record<string, unknown> = { tool }
    const cmd = inputText(state.input)
    if (cmd) meta.cmd = cmd
    if (state.title) meta.title = state.title
    const filePath = state.input?.['file_path'] ?? state.input?.['filePath'] ?? state.input?.['path']
    if (typeof filePath === 'string') meta.file = filePath
    const added = state.metadata?.['added'] ?? state.metadata?.['additions']
    const removed = state.metadata?.['removed'] ?? state.metadata?.['deletions']
    if (typeof added === 'number') meta.added = added
    if (typeof removed === 'number') meta.removed = removed
    if (state.status === 'error' && state.error) meta.error = state.error
    const text = meta.title ?? (kind === 'terminal' ? String(cmd || '') : String((meta.file ?? cmd) || tool))
    return { id, kind, ts: ts(state.time?.start ?? fallbackTsMs(fallbackTs)), status, text, meta }
  }

  if (type === 'patch') {
    const files = Array.isArray(part.files) ? part.files : []
    return { id, kind: 'patch', ts: fallbackTs, text: files.length ? `变更 ${files.length} 个文件` : '工作区变更', meta: { files } }
  }

  if (type === 'step-start' || type === 'step-finish') return null
  if (type === 'snapshot') return null
  if (type === 'file') return null

  if (type === 'retry') {
    return { id, kind: 'system', ts: fallbackTs, text: `自动重试（第 ${part.attempt ?? '?'} 次）`, meta: { retry: true } }
  }
  if (type === 'compaction') {
    return { id, kind: 'system', ts: fallbackTs, text: '上下文已压缩', meta: { compaction: true } }
  }
  if (type === 'subtask') {
    return { id, kind: 'tool', ts: fallbackTs, status: 'completed', text: part.description ?? part.prompt ?? '子任务', meta: { tool: part.agent ?? 'subtask' } }
  }

  return null
}

function fallbackTsMs(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : Date.now()
}

/** 整条消息（info+parts）→ 事件列表 */
export function messageToEvents(msg: ZcodeMessageWithParts): TimelineEvent[] {
  const info = msg.info ?? {}
  const role = info.role ?? 'assistant'
  const msgId = String(info.id ?? Math.random().toString(36).slice(2))
  const fallback = ts(info.time?.created ?? info.time?.completed)
  const out: TimelineEvent[] = []
  for (const part of msg.parts ?? []) {
    const ev = partToEvent(part, msgId, role, fallback)
    if (ev) out.push(ev)
  }
  // assistant 消息出错且没有任何事件时，给出错误行
  if (role === 'assistant' && info.error && out.length === 0) {
    out.push({ id: `${msgId}:error`, kind: 'system', ts: fallback, status: 'error', text: String(info.error.message ?? '模型调用出错') })
  }
  return out
}

/** ZCodeSessionInfo.status → 统一 SessionStatus */
export function mapStatus(status: string | undefined): TimelineEvent['status'] | string {
  switch (status) {
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting-approval'
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    case 'paused':
    case 'idle':
      return 'idle'
    default:
      return 'unknown'
  }
}
