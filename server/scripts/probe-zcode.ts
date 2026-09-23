/**
 * ZCode app-server 探测脚本（开发用）：
 *   node scripts/probe-zcode.ts
 * 验证：session/list（legacy）+ v4/conversation/rowsRange（无需激活）+ v4 订阅实时帧。
 */
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AppServerConnection } from '../src/adapters/zcode/connection.ts'

function resolveCommand(): string {
  if (process.env.ZCODE_CLI) return process.env.ZCODE_CLI
  const candidates = [
    'E:\\zcode\\resources\\glm\\zcode.cjs',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('未找到 zcode CLI')
}

async function main(): Promise<void> {
  const conn = new AppServerConnection()
  const cmd = resolveCommand()
  const cwd = process.env.ZCODE_PROBE_CWD ?? os.homedir()
  console.log(`[probe] 启动 ${cmd}（cwd=${cwd}）`)
  await conn.start(cmd, ['app-server', '--stdio'], cwd, (line) => console.log(`[stderr] ${line.slice(0, 200)}`))

  const list = (await conn.request('session/list', { includeArchived: false, limit: 200 }, 30_000)) as {
    sessions?: Record<string, unknown>[]
  }
  const sessions = list?.sessions ?? []
  console.log(`[probe] session/list → ${sessions.length} 个会话`)

  // 收集 v4 帧通知
  let frameCount = 0
  conn.onAnyNotification((method, params) => {
    if (method === 'v4/conversation/frame') {
      frameCount += 1
      if (frameCount <= 3) console.log(`[frame] ${JSON.stringify(params).slice(0, 400)}`)
    }
  })

  for (const target of sessions.slice(0, 2)) {
    const sid = String(target.sessionId)
    console.log(`\n===== ${sid}（${String(target.title).slice(0, 20)}）`)
    try {
      const res = (await conn.requestUuid(
        'v4/conversation/rowsRange',
        { sessionId: sid, clientMode: 'web-remote-replayable', limit: 200 },
        20_000,
      )) as { rows?: Record<string, unknown>[]; hasMore?: boolean; atSeq?: number }
      const rows = res?.rows ?? []
      console.log(`[probe] rowsRange → ${rows.length} 行（hasMore=${res?.hasMore}，atSeq=${res?.atSeq}）`)
      const byKind = new Map<string, number>()
      for (const r of rows) byKind.set(String(r.kind), (byKind.get(String(r.kind)) ?? 0) + 1)
      console.log(`[probe] 行类型分布: ${JSON.stringify([...byKind.entries()])}`)
      for (const r of rows.slice(0, 12)) {
        const brief: Record<string, unknown> = { kind: r.kind, rowId: r.rowId, ts: r.ts }
        if ('text' in r) brief.text = String(r.text).slice(0, 40)
        if ('toolName' in r) brief.tool = r.toolName
        if ('status' in r) brief.status = r.status
        if ('state' in r) brief.state = r.state
        if ('durationMs' in r) brief.durationMs = r.durationMs
        if ('approvalInteractionId' in r) brief.approval = r.approvalInteractionId
        console.log(`  ${JSON.stringify(brief)}`)
      }
    } catch (e) {
      console.log(`[probe] rowsRange 失败: ${String(e).slice(0, 300)}`)
      continue
    }

    // v4 订阅
    try {
      const ack = await conn.requestUuid(
        'v4/conversation/subscribe',
        {
          topic: `conversation/${sid}`,
          clientMode: 'web-remote-replayable',
          subscriptionId: `probe-${Date.now()}`,
        },
        15_000,
      )
      console.log(`[probe] subscribe ack → ${JSON.stringify(ack).slice(0, 200)}`)
    } catch (e) {
      console.log(`[probe] subscribe 失败: ${String(e).slice(0, 300)}`)
    }
  }

  console.log('[probe] 监听实时帧 5 秒…')
  await new Promise((r) => setTimeout(r, 5000))
  console.log(`[probe] 5 秒内收到 v4/conversation/frame: ${frameCount} 条`)

  await conn.close()
  console.log('[probe] 完成')
  process.exit(0)
}

main().catch((e) => {
  console.error('[probe] 失败:', e)
  process.exit(1)
})
