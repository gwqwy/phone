/** 列出最近 2 小时创建/更新的会话（排查用） */
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
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
    sessions?: Record<string, unknown>[]
  }
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  const recent = (list?.sessions ?? []).filter((s) => {
    const updated = typeof s.updatedAt === 'number' ? (s.updatedAt < 1e12 ? s.updatedAt * 1000 : s.updatedAt) : new Date(String(s.updatedAt)).getTime()
    return Number.isFinite(updated) && updated > cutoff
  })
  console.log(`[recent] ${recent.length} 个近 2 小时会话`)
  for (const s of recent) {
    console.log(`  - ${s.sessionId} | title=${JSON.stringify(s.title)} | status=${s.status} | created=${String(s.createdAt)} | ws=${JSON.stringify((s.workspace as Record<string, unknown>)?.workspacePath)}`)
  }
  await conn.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
