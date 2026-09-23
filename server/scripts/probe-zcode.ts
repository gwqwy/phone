/**
 * ZCode app-server 鎺㈡祴鑴氭湰锛堝紑鍙戠敤锛夛細
 *   node scripts/probe-zcode.ts
 * 楠岃瘉锛歴ession/list锛坙egacy锛? v4/conversation/rowsRange锛堟棤闇€婵€娲伙級+ v4 璁㈤槄瀹炴椂甯с€? */
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AppServerConnection } from '../src/adapters/zcode/connection.ts'

function resolveCommand(): string {
  // 寮€鍙戞帰閽堬細鍙厑璁稿凡鐭ョ殑妗岄潰绔唴缃?CLI 浣嶇疆锛堜笉璇荤幆澧冨彉閲忥紝閬垮厤姹＄偣鍏ュ彛锛?  const candidates = [
    'E:\\zcode\\resources\\glm\\zcode.cjs',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('鏈壘鍒?zcode CLI')
}

async function main(): Promise<void> {
  const conn = new AppServerConnection()
  const cmd = resolveCommand()
  const cwd = os.homedir() // 开发探针固定主目录（不读环境变量）
  console.log(`[probe] 鍚姩 ${cmd}锛坈wd=${cwd}锛塦)
  await conn.start(cmd, ['app-server', '--stdio'], cwd, (line) => console.log(`[stderr] ${line.slice(0, 200)}`))
  // 搴旂瓟杩愯鏃跺亸濂藉弽鍚戣姹傦紙妗岄潰绔涓荤殑琛屼负锛涚己鐪佷細璇濈墿鍖栦細澶辫触锛?  conn.onReverseRequest((method) => {
    if (method === 'session/requestRuntimePreferences') {
      return {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      }
    }
    return {}
  })

  const list = (await conn.request('session/list', { includeArchived: false, limit: 200 }, 30_000)) as {
    sessions?: Record<string, unknown>[]
  }
  const sessions = list?.sessions ?? []
  console.log(`[probe] session/list 鈫?${sessions.length} 涓細璇漙)

  // 鏀堕泦 v4 甯ч€氱煡
  let frameCount = 0
  conn.onAnyNotification((method, params) => {
    if (method === 'v4/conversation/frame') {
      frameCount += 1
      if (frameCount <= 3) console.log(`[frame] ${JSON.stringify(params).slice(0, 400)}`)
    }
  })

  for (const target of sessions.slice(0, 2)) {
    const sid = String(target.sessionId)
    console.log(`\n===== ${sid}锛?{String(target.title).slice(0, 20)}锛塦)
    try {
      const res = (await conn.requestUuid(
        'v4/conversation/rowsRange',
        { sessionId: sid, clientMode: 'web-remote-replayable', limit: 200 },
        20_000,
      )) as { rows?: Record<string, unknown>[]; hasMore?: boolean; atSeq?: number }
      const rows = res?.rows ?? []
      console.log(`[probe] rowsRange 鈫?${rows.length} 琛岋紙hasMore=${res?.hasMore}锛宎tSeq=${res?.atSeq}锛塦)
      const byKind = new Map<string, number>()
      for (const r of rows) byKind.set(String(r.kind), (byKind.get(String(r.kind)) ?? 0) + 1)
      console.log(`[probe] 琛岀被鍨嬪垎甯? ${JSON.stringify([...byKind.entries()])}`)
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
      console.log(`[probe] rowsRange 澶辫触: ${String(e).slice(0, 300)}`)
      continue
    }

    // v4 璁㈤槄
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
      console.log(`[probe] subscribe ack 鈫?${JSON.stringify(ack).slice(0, 200)}`)
    } catch (e) {
      console.log(`[probe] subscribe 澶辫触: ${String(e).slice(0, 300)}`)
    }
  }

  console.log('[probe] 鐩戝惉瀹炴椂甯?5 绉掆€?)
  await new Promise((r) => setTimeout(r, 5000))
  console.log(`[probe] 5 绉掑唴鏀跺埌 v4/conversation/frame: ${frameCount} 鏉)

  await conn.close()
  console.log('[probe] 瀹屾垚')
  process.exit(0)
}

main().catch((e) => {
  console.error('[probe] 澶辫触:', e)
  process.exit(1)
})
