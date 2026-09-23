import type { HarnessAdapter, HistoryRange, StreamCallback } from '../../core/harness.ts'
import { NO_CAPABILITIES, type CapabilitySet, type StreamFrame, type TaskSummary, type TimelineEvent, type Workspace } from '../../protocol.ts'
import { info } from '../../log.ts'
import type { AppConfig } from '../../config.ts'

/**
 * ZCode 适配器。
 * M0：占位（未就绪）。M1：拉起 `zcode app-server`（stdio NDJSON 协议）并桥接到统一协议。
 */
export class ZcodeAdapter implements HarnessAdapter {
  readonly id = 'zcode'
  readonly label = 'ZCode'
  #ready = false
  #config: AppConfig

  constructor(config: AppConfig) {
    this.#config = config
    void this.#config
  }

  capabilities(): CapabilitySet {
    return { ...NO_CAPABILITIES }
  }

  isReady(): boolean {
    return this.#ready
  }

  async start(): Promise<void> {
    info('[zcode] 占位适配器：M1 接入 app-server 进程')
  }

  async stop(): Promise<void> {}

  async listWorkspaces(): Promise<Workspace[]> {
    return []
  }

  async listSessions(): Promise<TaskSummary[]> {
    return []
  }

  async history(_sessionId: string, _range?: HistoryRange): Promise<TimelineEvent[]> {
    return []
  }

  subscribe(_sessionId: string, _cb: StreamCallback): () => void {
    return () => {}
  }
}
