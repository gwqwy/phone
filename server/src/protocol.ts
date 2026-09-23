/**
 * 服务端与手机端之间的统一协议类型。
 * client/src/api/types.ts 是它的镜像，改这里时务必同步客户端。
 */

export type SessionStatus =
  | 'running'
  | 'idle'
  | 'completed'
  | 'error'
  | 'waiting-approval'
  | 'unknown'

export interface Workspace {
  id: string
  name: string
  path: string
}

export interface TaskSummary {
  id: string
  workspaceId: string
  title: string
  status: SessionStatus
  updatedAt: string
  /** 元数据覆盖层（.data/meta.json，harness 无关） */
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  alias?: string
}

export type EventKind =
  | 'user'
  | 'text'
  | 'think'
  | 'terminal'
  | 'edit'
  | 'tool'
  | 'patch'
  | 'step'
  | 'system'
  | 'approval'

export type EventStatus = 'pending' | 'running' | 'completed' | 'error'

export interface TimelineEvent {
  id: string
  kind: EventKind
  ts: string
  status?: EventStatus
  text?: string
  /** 附加展示数据：file/added/removed/cmd/tool/diff/interaction 等 */
  meta?: Record<string, unknown>
}

export interface StreamFrame {
  kind: 'snapshot' | 'append' | 'update' | 'end'
  events?: TimelineEvent[]
  summary?: Partial<TaskSummary>
}

export interface CapabilitySet {
  sendText: boolean
  stop: boolean
  approvals: boolean
  review: boolean
  terminal: boolean
  /** 支持远程新建任务（session/create + 首条输入） */
  createTask: boolean
}

export const NO_CAPABILITIES: CapabilitySet = {
  sendText: false,
  stop: false,
  approvals: false,
  review: false,
  terminal: false,
  createTask: false,
}

/** WebSocket 帧协议（手机 ↔ 本服务） */
export interface ReqFrame {
  t: 'req'
  id: string
  method: string
  payload?: unknown
}
export interface SubFrame {
  t: 'sub'
  id: string
  topic: 'sessions-index' | 'session-stream'
  params?: { sessionId?: string }
}
export interface UnsubFrame {
  t: 'unsub'
  id: string
}
export interface ResFrame {
  t: 'res'
  id: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}
export interface PushFrame {
  t: 'push'
  sub: string
  kind: 'replace' | 'append' | 'update' | 'end'
  data: unknown
}
export interface HelloFrame {
  t: 'hello'
  server: string
  adapters: { id: string; label: string; ready: boolean; capabilities: CapabilitySet }[]
}
export type ClientFrame = ReqFrame | SubFrame | UnsubFrame
export type ServerFrame = ResFrame | PushFrame | HelloFrame
