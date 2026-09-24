/**
 * v4 会话行 → 时间线条目。
 *
 * 字段名全部来自官方 OSS（`packages/shared/src/zcode-protocol-v4/rows.ts`）：
 * `conversationRowSchema` 是按 `kind` 判别的联合，共有 9 种行；公共字段是
 * `{rowId, turnId, entityId?, createdAt, createdAtSeq, actions?}`；
 * `v4/conversation/rowsRange` 的返回是 `{rows, atSeq, atRevision, atLogEpoch, hasMore}`
 * 且 rows 按 rowId 升序。
 *
 * 仍然保留未知行的兜底：认不出的 kind 原样显示 JSON，而不是静默吞掉——
 * 协议比我们跑得快，展示总比丢失安全。
 */

export const KIND_TURN = 'turn'
export const KIND_USER = 'user'
export const KIND_TEXT = 'text'
export const KIND_THINK = 'think'
export const KIND_TOOL = 'tool'
export const KIND_TERMINAL = 'terminal'
export const KIND_EDIT = 'edit'
export const KIND_ARTIFACT = 'artifact'
export const KIND_SUBAGENT = 'subagent'
export const KIND_MARKER = 'marker'
export const KIND_HOOK = 'hook'
export const KIND_UNKNOWN = 'unknown'

/** 工具名到展示类别的启发式：终端与文件改动在时间线上要长得不一样。 */
function toolKindOf(toolName) {
  const name = String(toolName ?? '').toLowerCase()
  if (/bash|shell|terminal|exec|command/.test(name)) return KIND_TERMINAL
  if (/edit|write|patch|apply|multiedit|create_file|str_replace/.test(name)) return KIND_EDIT
  return KIND_TOOL
}

function ms(value) {
  return typeof value === 'number' && isFinite(value) ? value : null
}

/**
 * 单行 → 时间线条目。
 * @returns {object|null} 认不出结构时返回 null（调用方跳过）
 */
export function mapRow(row) {
  if (!row || typeof row !== 'object') return null
  const kind = String(row.kind ?? '')
  const base = {
    id: String(row.rowId ?? row.entityId ?? ''),
    turnId: row.turnId ?? '',
    at: ms(row.createdAt),
    kind: KIND_UNKNOWN,
    title: '',
    text: '',
    meta: '',
    detail: '',
  }

  switch (kind) {
    case 'turnHeader': {
      const duration =
        ms(row.endedAt) !== null && ms(row.startedAt) !== null ? ms(row.endedAt) - ms(row.startedAt) : null
      return {
        ...base,
        kind: KIND_TURN,
        title: turnTitle(row),
        meta: duration !== null ? formatDuration(duration) : '',
        detail: row.state ?? '',
      }
    }

    case 'userInput':
      return { ...base, kind: KIND_USER, text: String(row.text ?? '') }

    case 'assistantText':
      return {
        ...base,
        kind: KIND_TEXT,
        text: String(row.text ?? ''),
        meta: row.model ? String(row.model) : '',
        detail: row.state ?? '',
      }

    case 'reasoning': {
      const duration = ms(row.durationMs)
      return {
        ...base,
        kind: KIND_THINK,
        text: String(row.text ?? ''),
        meta: duration !== null ? formatDuration(duration) : '',
        detail: row.state ?? '',
      }
    }

    case 'toolCall': {
      const kindName = toolKindOf(row.toolName)
      return {
        ...base,
        kind: kindName,
        title: row.toolName ? String(row.toolName) : '',
        text: toolText(row),
        meta: String(row.status ?? ''),
        detail: row.error?.message ? String(row.error.message) : '',
      }
    }

    case 'artifact':
      return {
        ...base,
        kind: KIND_ARTIFACT,
        title: String(row.displayName ?? ''),
        meta: [row.artifactType, formatBytes(ms(row.sizeBytes))].filter(Boolean).join(' · '),
      }

    case 'subagent':
      return {
        ...base,
        kind: KIND_SUBAGENT,
        title: String(row.subagentType ?? ''),
        text: String(row.summaryText ?? ''),
        meta: String(row.status ?? ''),
      }

    case 'timelineMarker':
      return {
        ...base,
        kind: KIND_MARKER,
        title: markerTitle(row.marker),
        meta: row.lane ? String(row.lane) : '',
      }

    case 'hookInvocation':
      return {
        ...base,
        kind: KIND_HOOK,
        title: String(row.hookName ?? row.name ?? 'hook'),
        meta: String(row.status ?? ''),
      }

    default:
      return { ...base, kind: KIND_UNKNOWN, text: safeJson(row) }
  }
}

function turnTitle(row) {
  const state = String(row.state ?? '')
  if (state === 'running') return '进行中'
  if (state === 'completedSuccess') return '完成'
  if (state === 'completedInterrupted') return '被中断'
  if (state === 'failed') return '失败'
  return row.origin ? String(row.origin) : '一轮'
}

/** 工具行里最值得显示的那段文字：优先真实输出，其次命令/入参。 */
function toolText(row) {
  const preview = row.outputPreview?.text ?? row.outputPreview?.preview
  if (typeof preview === 'string' && preview) return preview
  const output = row.output
  if (typeof output === 'string' && output) return output
  if (output && typeof output === 'object' && typeof output.text === 'string') return output.text
  if (typeof row.inputText === 'string' && row.inputText) return row.inputText
  if (row.input !== undefined) return safeJson(row.input)
  return ''
}

function markerTitle(marker) {
  if (!marker || typeof marker !== 'object') return '标记'
  return String(marker.label ?? marker.title ?? marker.type ?? '标记')
}

export function formatDuration(msValue) {
  if (typeof msValue !== 'number' || !isFinite(msValue) || msValue < 0) return ''
  const seconds = Math.round(msValue / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatBytes(value) {
  if (typeof value !== 'number' || !isFinite(value)) return ''
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

/**
 * rowsRange 的返回值 → 时间线。
 *
 * 接受 `{rows: [...]}`，也接受裸数组；行内**不做排序**——协议保证 rowId 升序，
 * 客户端再排一次只会在协议演进时引入分歧。
 */
export function toTimeline(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : []
  const items = []
  for (const row of rows) {
    const item = mapRow(row)
    if (item) items.push(item)
  }
  return items
}

/** 会话级汇总：给侧面板用的增删与涉及文件。 */
export function summarize(items) {
  let edits = 0
  const files = new Set()
  for (const item of items) {
    if (item.kind === KIND_EDIT) edits += 1
    if (item.kind === KIND_ARTIFACT && item.title) files.add(item.title)
    const named = /(?:^|\s)([\w./\\:-]+\.[A-Za-z0-9]{1,6})(?:\s|$)/.exec(item.text ?? '')
    if (named) files.add(named[1])
  }
  return { edits, additions: edits, deletions: 0, files: [...files] }
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    if (!text) return ''
    return text.length > 1200 ? text.slice(0, 1200) + '…' : text
  } catch {
    return ''
  }
}
