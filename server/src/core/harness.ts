import type { CapabilitySet, StreamFrame, TaskSummary, TimelineEvent, Workspace } from '../protocol.ts'

export type StreamCallback = (frame: StreamFrame) => void

export interface HistoryRange {
  before?: string
  limit?: number
}

/**
 * Harness 适配器契约 —— 接入一个新的编码智能体（ZCode / DeepSeek Harness / ...）
 * 只需实现本接口并在 index.ts 注册。所有类型见 ../protocol.ts。
 */
export interface HarnessAdapter {
  readonly id: string
  readonly label: string

  capabilities(): CapabilitySet
  isReady(): boolean
  start(): Promise<void>
  stop(): Promise<void>

  listWorkspaces(): Promise<Workspace[]>
  listSessions(workspaceId?: string): Promise<TaskSummary[]>
  history(sessionId: string, range?: HistoryRange): Promise<TimelineEvent[]>

  /** 订阅某会话的实时帧流；返回退订函数 */
  subscribe(sessionId: string, cb: StreamCallback): () => void

  // 可选能力（capabilities() 里声明后手机端才显示）
  sendText?(sessionId: string, text: string): Promise<void>
  stopSession?(sessionId: string): Promise<void>
  resolveInteraction?(sessionId: string, interactionId: string, outcome: 'approve' | 'reject'): Promise<void>
  /** 在指定工作区新建任务并发送首条输入（harness 需自行管理其运行时激活） */
  createSession?(workspaceId: string, text: string): Promise<{ sessionId: string }>
  /** 审查面板：该会话的代码变更汇总 */
  review?(sessionId: string): Promise<{ additions: number; deletions: number; files: string[] }>
}

type IndexListener = () => void

export class HarnessRegistry {
  #adapters = new Map<string, HarnessAdapter>()
  #active: HarnessAdapter | null = null
  #listeners = new Set<IndexListener>()

  register(adapter: HarnessAdapter, active = false): void {
    this.#adapters.set(adapter.id, adapter)
    if (active || !this.#active) this.#active = adapter
  }

  get active(): HarnessAdapter | null {
    return this.#active
  }

  list(): { id: string; label: string; ready: boolean; capabilities: CapabilitySet }[] {
    return [...this.#adapters.values()].map((a) => ({
      id: a.id,
      label: a.label,
      ready: a.isReady(),
      capabilities: a.capabilities(),
    }))
  }

  onIndexChanged(cb: IndexListener): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /** 适配器在任务列表变化时调用，广播给所有订阅方 */
  notifyIndexChanged(): void {
    for (const cb of this.#listeners) {
      try {
        cb()
      } catch {
        // 监听器异常不影响其他监听器
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const a of this.#adapters.values()) {
      try {
        await a.stop()
      } catch {
        // 关闭失败忽略
      }
    }
  }
}
