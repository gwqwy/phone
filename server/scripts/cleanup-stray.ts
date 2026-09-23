/** 清理本次 M2 测试误建的会话（仅删除 60 分钟内创建的"未命名任务"） */
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppServerConnection } from '../src/adapters/zcode/connection.ts'

function resolveCommand(): string {
  const candidates = ['E:\\zcode\\resources\\glm\\zcode.cjs', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs')]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('未找到 zcode CLI')
}

async function main(): Promise<void> {
  const conn = new AppServerConnection()
  await conn.start(resolveCommand(), ['app-server', '--stdio'], os.homedir(), () => {})
  conn.onReverseRequest((method) => {
    if (method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
    }
    return {}
  })

  const list = (await conn.request('session/list', { includeArchived: false, limit: 200 }, 30_000)) as {
    sessions?: { sessionId: string; title?: string; createdAt?: string | number }[]
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  const strays = (list?.sessions ?? []).filter((s) => {
    const created = typeof s.createdAt === 'number' ? (s.createdAt < 1e12 ? s.createdAt * 1000 : s.createdAt) : new Date(String(s.createdAt)).getTime()
    return s.title === '未命名任务' && Number.isFinite(created) && created > cutoff
  })
  console.log(`[cleanup] 命中 ${strays.length} 个待删会话`)
  for (const s of strays) {
    console.log(`  - ${s.sessionId}（${s.title}）`)
    try {
      const ack = await conn.requestUuid(
        'v4command',
        {
          commandId: randomUUID(),
          clientId: 'zphone-cleanup',
          sessionId: s.sessionId,
          type: 'deleteSession',
          payload: {},
          issuedAt: new Date().toISOString(),
        },
        30_000,
      )
      console.log(`    → ${JSON.stringify(ack).slice(0, 120)}`)
    } catch (e) {
      console.log(`    → 删除失败: ${String(e).slice(0, 140)}`)
    }
  }
  await conn.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('[cleanup] 失败:', e)
  process.exit(1)
})
