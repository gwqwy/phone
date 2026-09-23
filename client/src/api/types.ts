/** 与 server/src/protocol.ts 保持镜像 */

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
  meta?: Record<string, unknown>
}

export interface CapabilitySet {
  sendText: boolean
  stop: boolean
  approvals: boolean
  review: boolean
  terminal: boolean
}

export interface AdapterInfo {
  id: string
  label: string
  ready: boolean
  capabilities: CapabilitySet
}

export interface HelloFrame {
  t: 'hello'
  server: string
  adapters: AdapterInfo[]
}

export interface SessionsIndex {
  ready: boolean
  adapterId: string | null
  workspaces: Workspace[]
  tasks: TaskSummary[]
}

export type ClientFrame =
  | { t: 'req'; id: string; method: string; payload?: unknown }
  | { t: 'sub'; id: string; topic: 'sessions-index' | 'session-stream'; params?: { sessionId?: string; includeArchived?: boolean } }
  | { t: 'unsub'; id: string }

export type ServerFrame =
  | { t: 'res'; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } }
  | { t: 'push'; sub: string; kind: 'replace' | 'snapshot' | 'append' | 'update' | 'end'; data: unknown }
  | HelloFrame
