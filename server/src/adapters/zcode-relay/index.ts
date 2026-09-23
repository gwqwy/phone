import { parsePairingUrl, RelayClient, type RelayPairing } from './relay-client.ts'
import { randomUUID } from 'node:crypto'
import type { HarnessAdapter, HistoryRange, StreamCallback } from '../../core/harness.ts'
import type { AppConfig } from '../../config.ts'
import { NO_CAPABILITIES, type CapabilitySet, type StreamFrame, type TaskSummary, type TimelineEvent, type Workspace } from '../../protocol.ts'
import { info, warn } from '../../log.ts'

/** 桌面端 displayStatus → 统一状态 */
function relayStatus(s: string): TaskSummary['status'] {
  switch (s) {
    case 'running':
    case 'inProgress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'error'
    case 'waiting':
    case 'waitingApproval':
      return 'waiting-approval'
    case 'idle':
      return 'idle'
    default:
      return 'unknown'
  }
}

/**
 * 官方中继直连适配器（进行中）。
 *
 * 凭桌面端「远程控制」生成的配对链接（config.json 的 relayPairingUrl）直连
 * wss://zcode.z.ai/ws。认证与配对已实测打通（docs/relay-protocol.md）；
 * 数据面（v4 客户端：sessions-index / conversation / command）在接入中——
 * 当前先建立通道并把桌面端推送的 v4 消息记录到日志，用于完成内层编码实证。
 *
 * 能力（完成后）：sendText/stop/approvals/createTask 全开——执行方是桌面端自身，
 * 不受本地 headless 的账号注入限制。
 */
export class ZcodeRelayAdapter implements HarnessAdapter {
  readonly id = 'zcode-relay'
  readonly label = 'ZCode（官方中继）'
  #client: RelayClient | null = null
  #pairing: RelayPairing | null = null
  #ready = false
  #config: AppConfig
  #onIndexChanged: () => void
  #v4LogCount = 0
  #workspaces: Workspace[] = []
  #relayTasks: TaskSummary[] = []
  #activeWorkspaceKey = ''
  #activeTaskId = ''
  #bridge: Record<string, unknown> | null = null

  /** 阶段一：bootstrap → workspace-list → bridge-open（为阶段二 RPC 拿桥接身份） */
  async #probePhaseOne(): Promise<void> {
    const boot = await this.#client?.requestBootstrap()
    if (boot) {
      const result = (boot.result ?? {}) as Record<string, unknown>
      const view = (result.initialViewState ?? {}) as Record<string, unknown>
      this.#activeWorkspaceKey = String(view.activeWorkspaceKey ?? result.activeWorkspaceKey ?? '')
      this.#activeTaskId = String(view.activeTaskId ?? result.activeTaskId ?? '')
    }
    const list = await this.#client?.requestWorkspaceList()
    if (list) {
      // 实测结构：{result:{activeTaskId, activeWorkspaceKey, tasks:[{taskId,title,displayStatus,provider,createdAt,updatedAt,workspaceKey}]}}
      const result = (list.result ?? {}) as Record<string, unknown>
      const tasks = (Array.isArray(result.tasks) ? result.tasks : []) as Record<string, unknown>[]
      const activeKey = String(result.activeWorkspaceKey ?? '')
      if (activeKey) this.#activeWorkspaceKey = activeKey
      const wsMap = new Map<string, Workspace>()
      this.#relayTasks = []
      for (const t of tasks) {
        const taskId = String(t.taskId ?? t.id ?? '')
        if (!taskId) continue
        const wsKey = String(t.workspaceKey ?? activeKey ?? '')
        const wsPath = wsKey
        const created = Number(t.createdAt ?? 0)
        const updated = Number(t.updatedAt ?? created)
        this.#relayTasks.push({
          id: taskId,
          workspaceId: wsKey,
          title: String(t.title ?? '未命名任务'),
          status: relayStatus(String(t.displayStatus ?? t.status ?? '')),
          updatedAt: new Date(updated || Date.now()).toISOString(),
        })
        if (wsKey && !wsMap.has(wsKey)) {
          wsMap.set(wsKey, { id: wsKey, name: wsPath.split(/[\\/]/).pop() ?? wsKey, path: wsPath })
        }
      }
      this.#workspaces = [...wsMap.values()]
      info(`[relay] 工作区 ${this.#workspaces.length} 个，任务 ${this.#relayTasks.length} 个`)
    }
    const key = this.#activeWorkspaceKey || this.#workspaces[0]?.id
    if (key) {
      const bridge = await this.#client?.openBridge(key, this.#activeTaskId || undefined)
      if (bridge) {
        this.#bridge = (bridge.bridge ?? bridge) as Record<string, unknown>
        info(`[relay] 桥接就绪：${JSON.stringify(this.#bridge).slice(0, 200)}`)
        this.#client?.startKeepAlive()
        void this.#rpcHandshake()
      }
    }
    this.#onIndexChanged()
  }

  /** 阶段二：桥接内 RPC 握手（官方 mobile 序列：helloConversationV4 → initializeConversationV4） */
  async #rpcHandshake(): Promise<void> {
    const client = this.#client
    if (!client) return
    try {
      const hello = await client.rpcCall('helloConversationV4', undefined, 20_000)
      info(`[relay][rpc] hello → ${JSON.stringify(hello).slice(0, 300)}`)
      const clientHello = {
        kind: 'clientHello',
        protocolVersion: 3,
        clientId: randomUUID(),
        clientKind: 'mobileRemote',
        appVersion: this.#config.relayPairingUrl ? 'web' : 'unknown',
        capabilities: { workspaceHookReviewUi: true },
      }
      const init = await client.rpcCall('initializeConversationV4', clientHello, 20_000)
      info(`[relay][rpc] initializeConversationV4 → ${JSON.stringify(init ?? null).slice(0, 200)}`)
      // 订阅会话索引（任务列表）
      const sub = await client.rpcCall(
        'subscribeSessionsIndexV4',
        { subscriptionId: `zphone-${Date.now()}`, clientMode: 'web-remote-replayable' },
        20_000,
      )
      info(`[relay][rpc] subscribeSessionsIndexV4 → ${JSON.stringify(sub ?? null).slice(0, 240)}`)
    } catch (e) {
      warn(`[relay][rpc] 握手失败（可能需先 Initialize 帧）：${String(e).slice(0, 200)}`)
    }
  }

  constructor(config: AppConfig, onIndexChanged: () => void) {
    this.#config = config
    this.#onIndexChanged = onIndexChanged
    void this.#onIndexChanged
  }

  capabilities(): CapabilitySet {
    // 数据面接入完成前保持最小能力面
    return { ...NO_CAPABILITIES, sendText: true, stop: true, approvals: true, createTask: true }
  }

  isReady(): boolean {
    return this.#ready
  }

  async start(): Promise<void> {
    const url = (this.#config.relayPairingUrl ?? '').trim()
    if (!url) {
      info('[relay] 未配置 relayPairingUrl（桌面端「远程控制」生成配对链接后填入 config.json）')
      return
    }
    const pairing = parsePairingUrl(url)
    if (!pairing) {
      warn('[relay] relayPairingUrl 非法：仅支持官方中继域名 https://zcode.z.ai|zcode.chatglm.site/remote/...')
      return
    }
    this.#pairing = pairing
    this.#client = new RelayClient(pairing, {
      onState: (state, detail) => {
        info(`[relay] 状态=${state}${detail ? `（${detail}）` : ''}`)
        if (state === 'matched') {
          this.#ready = true
          this.#onIndexChanged()
          // 配对成功即跑阶段一探测：bootstrap → 工作区列表 → 桥接建立
          void this.#probePhaseOne()
        } else if (state === 'closed' || state === 'waiting') {
          if (this.#ready && state === 'closed') {
            this.#ready = false
            this.#onIndexChanged()
          }
        }
      },
      onV4Message: (msg) => {
        // 数据面实证阶段：记录桌面端推来的 v4 消息（前 40 条全量，之后仅计数）
        this.#v4LogCount += 1
        if (this.#v4LogCount <= 40) {
          info(`[relay][v4] ${JSON.stringify(msg).slice(0, 400)}`)
        }
      },
      onInnerJson: (frame) => {
        this.#v4LogCount += 1
        if (this.#v4LogCount <= 40) {
          info(`[relay][inner] ${JSON.stringify(frame).slice(0, 300)}`)
        }
      },
      onBootstrap: (frame) => {
        info(`[relay][v4] 数据面通道就绪（bootstrap ok）`)
        void frame
      },
      onFault: (code, message) => {
        warn(`[relay] 故障 ${code} ${message.slice(0, 120)}`)
      },
    })
    this.#client.connect()
    info(`[relay] 连接 ${pairing.wsUrl}（deviceSid=${pairing.deviceSid.slice(0, 8)}…）`)
  }

  async stop(): Promise<void> {
    this.#client?.close()
    this.#client = null
    this.#ready = false
  }

  // 数据面（阶段一已可用：工作区与任务列表来自桌面端中继）
  async listWorkspaces(): Promise<Workspace[]> {
    return this.#workspaces
  }

  async listSessions(): Promise<TaskSummary[]> {
    // 状态为 running 的活跃任务 + 最近更新的任务
    const active = this.#activeTaskId
    return [...this.#relayTasks].sort((a, b) => {
      if (a.id === active) return -1
      if (b.id === active) return 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }

  async history(_sessionId: string, _range?: HistoryRange): Promise<TimelineEvent[]> {
    return []
  }

  subscribe(_sessionId: string, _cb: StreamCallback): () => void {
    return () => {}
  }

  // 控制面（待数据面完成后接 v4command）
  async sendText(_sessionId: string, _text: string): Promise<void> {
    if (!this.#ready) throw new Error('中继未配对（桌面端「远程控制」需处于已连接状态）')
    throw new Error('中继数据面接入中：v4command 将在下一版本启用')
  }
}
