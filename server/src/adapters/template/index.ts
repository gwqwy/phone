import type { HarnessAdapter, HistoryRange, StreamCallback } from '../../core/harness.ts'
import { NO_CAPABILITIES, type CapabilitySet, type StreamFrame, type TaskSummary, type TimelineEvent, type Workspace } from '../../protocol.ts'

/**
 * ─── 新 harness 接入模板 ──────────────────────────────────────────────
 *
 * 接入一个新的编码智能体只需：
 *   1. 复制本目录为 adapters/<id>/
 *   2. 实现下方 HarnessAdapter 的全部必选方法
 *   3. 在 src/index.ts 里 register(new XxxAdapter(config, onIndexChanged), true)
 *
 * 完整契约文档见 adapters/README.md。所有类型见 src/protocol.ts。
 *
 * ─── 示例：DeepSeek Harness（dsh web）接入要点 ────────────────────────
 * 上游：本机 `dsh web`（默认 127.0.0.1:3080），HTTP /api/* + WebSocket 流：
 *   - /api/events.mux / /api/events.host：多路复用事件流（WS 双向）
 *   - 会话握手：GET /?token=<启动token> 换 cookie（dsh-auth-* 前缀），
 *     token 取自 dsh 进程（参考 dsh-pocket/lib/proxy.mjs 的 upsteamPathWithLaunchToken）
 *   - 信任栅栏：dsh 校验 Host/Origin/Referer/Sec-Fetch-Site 为 loopback，
 *     代理转发时需改写这些头（同 dsh-pocket 的 loopbackAuthority() 做法）
 *   - 会话/消息模型：由 dsh web 内部定义，通过 /api 读取、WS 订阅增量
 * 映射：把 dsh 事件映射为统一 TimelineEvent（kind: user/text/think/terminal/edit/tool/patch/approval）
 * 安全：本适配器对上游只连 127.0.0.1；对外暴露由 server 的 PIN 层统一负责。
 */
export class TemplateAdapter implements HarnessAdapter {
  readonly id = 'template'
  readonly label = '模板（未接入）'

  capabilities(): CapabilitySet {
    // 按实际能力覆盖：sendText/stop/approvals/review/terminal/createTask
    return { ...NO_CAPABILITIES }
  }

  isReady(): boolean {
    return false
  }

  async start(): Promise<void> {
    // 1) 连接/拉起上游服务；2) 就绪后置 ready；3) 变更时调用 onIndexChanged()
  }

  async stop(): Promise<void> {}

  async listWorkspaces(): Promise<Workspace[]> {
    return []
  }

  async listSessions(_workspaceId?: string): Promise<TaskSummary[]> {
    return []
  }

  async history(_sessionId: string, _range?: HistoryRange): Promise<TimelineEvent[]> {
    return []
  }

  subscribe(_sessionId: string, _cb: StreamCallback): () => void {
    return () => {}
  }

  // 可选能力示例（capabilities() 声明后手机端才显示对应 UI）：
  // async sendText(sessionId: string, text: string): Promise<void> {}
  // async stopSession(sessionId: string): Promise<void> {}
  // async resolveInteraction(sessionId: string, interactionId: string, outcome: 'approve' | 'reject'): Promise<void> {}
  // async createSession(workspaceId: string, text: string): Promise<{ sessionId: string }> { return { sessionId: '' } }
  // async review(sessionId: string): Promise<{ additions: number; deletions: number; files: string[] }> { return { additions: 0, deletions: 0, files: [] } }
}
