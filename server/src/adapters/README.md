# Harness 适配器开发指南

本服务通过 **HarnessAdapter** 接口把不同的编码智能体（ZCode、DeepSeek Harness、……）
统一成同一套手机端协议。新增一个 harness = 新增一个适配器目录，**手机端零改动**。

## 统一协议速览

核心类型在 `../protocol.ts`（客户端镜像 `client/src/api/types.ts`）：

- `Workspace` / `TaskSummary` — 工作区与任务卡（`status: running|idle|completed|error|waiting-approval|unknown`）
- `TimelineEvent` — 时间线事件，`kind`:
  `user`（用户消息）`text`（AI 正文）`think`（思考，meta.durationSec）`terminal`（命令）
  `edit`（文件编辑，meta.file/added/removed）`tool`（其他工具）`patch`（变更集）
  `approval`（审批卡，meta.interactionId）`system`
- `StreamFrame` — 实时帧 `snapshot | append | update | end`
- `CapabilitySet` — 能力声明：`sendText stop approvals review terminal createTask`

手机端 ↔ 服务端走 `POST /api/*` + WS `/ws`（`req/sub/push` JSON 帧，PIN 认证），
适配器不感知传输与认证，只实现下面的接口。

## 必选实现

```ts
interface HarnessAdapter {
  id: string; label: string
  capabilities(): CapabilitySet          // 声明能力，UI 按此显示/隐藏
  isReady(): boolean
  start(): Promise<void>                 // 连接/拉起上游；就绪后通知 onIndexChanged
  stop(): Promise<void>
  listWorkspaces(): Promise<Workspace[]>
  listSessions(workspaceId?): Promise<TaskSummary[]>
  history(sessionId, range?): Promise<TimelineEvent[]>   // 首屏快照（建议最近 ~400 条消息）
  subscribe(sessionId, cb: (frame: StreamFrame) => void): () => void  // 实时帧
}
```

## 可选能力（按需实现 + capabilities() 声明）

| 方法 | 手机端行为 |
|---|---|
| `sendText(sessionId, text)` | 会话页输入框可发送 |
| `stopSession(sessionId)` | 运行中显示「停止」 |
| `resolveInteraction(sessionId, interactionId, outcome)` | 审批卡「批准/拒绝」 |
| `createSession(workspaceId, text)` | 首页「＋新建任务」 |
| `review(sessionId)` | 侧面板「审查」标签 |

注意：
- 任何列表/状态变化调用 `onIndexChanged()`（构造时注入的回调）→ 所有订阅 `sessions-index`
  的手机端立即收到新快照（置顶/归档等元数据由服务端统一叠加，适配器不用管）。
- `history` + `subscribe` 的配合：先回快照再推增量；事件 `id` 必须稳定
  （同一事件两次推送视为更新而非追加）。
- 长任务/流式：不必逐字推送，`update` 同 id 覆盖即可（客户端按 id 合并）。

## 注册

```ts
// src/index.ts
const adapter = new ZcodeAdapter(config, () => registry.notifyIndexChanged())
registry.register(adapter, true)   // 第二个参数 true = 设为 active（v0.1 单活动适配器）
```

## 参考实现

- `adapters/zcode/` — ZCode：
  - 列表/状态：stdio `zcode app-server` 的 `session/list` RPC
  - 历史：`v4/conversation/rowsRange`（官方 UI 投影）→ 只读 SQLite 兜底（`db.ts`）
  - 实时：`session/subscribe` + SQLite 轮询双保险（桌面端正在跑的会话也能看到推进）
  - 审批：服务端反向请求 `interaction/requestPermission` → 存挂起 → `resolveInteraction` 应答
  - 已知限制见根 README「已知限制」
- `adapters/template/` — DeepSeek Harness（dsh web）接入要点注释稿
