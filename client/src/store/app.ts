import { reactive } from 'vue'
import type { SessionsIndex } from '../api/types'

/** 工作区/任务索引（来自 sessions-index 订阅） */
export const index = reactive<SessionsIndex & { loaded: boolean }>({
  ready: false,
  adapterId: null,
  workspaces: [],
  tasks: [],
  loaded: false,
})

export function applyIndex(kind: string, data: unknown): void {
  if (kind !== 'replace' || !data || typeof data !== 'object') return
  const d = data as Partial<SessionsIndex>
  index.ready = d.ready ?? false
  index.adapterId = d.adapterId ?? null
  index.workspaces = d.workspaces ?? []
  index.tasks = d.tasks ?? []
  index.loaded = true
}
