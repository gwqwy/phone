/** 诊断：在新会话中尝试 send 并打印 session_entry（含 turn 失败原因） */
import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppServerConnection } from '../src/adapters/zcode/connection.ts'

function resolveCommand(): string {
  const candidates = ['E:\\zcode\\resources\\glm\\zcode.cjs', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs')]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('未找到 zcode CLI')
}

async function main(): Promise<void> {
  const conn = new AppServerConnection()
  await conn.start(resolveCommand(), ['app-server', '--stdio'], os.homedir(), (line) => {
    process.stdout.write(`[stderr] ${line.slice(0, 300)}\n`)
  })
  conn.onReverseRequest((method, params) => {
    process.stdout.write(`[reverse] ${method}\n`)
    if (method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
    }
    if (method === 'interaction/requestUserInput') {
      process.stdout.write(`[reverse-params] ${JSON.stringify(params).slice(0, 300)}\n`)
    }
    return {}
  })

  const wsRef = { workspacePath: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws', workspaceKey: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws' }
  const created = (await conn.request(
    'session/create',
    { workspace: wsRef, titleGenerationEnabled: false, persistence: 'immediate', model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro', options: { reasoningLevel: 'high' } } },
    60_000,
  )) as Record<string, unknown>
  const sessionId = String((created.session as Record<string, unknown> | undefined)?.sessionId ?? created.sessionId ?? '')
  process.stdout.write(`[diag] sessionId=${sessionId}\n`)

  conn.onAnyNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'session/event' && String(p.sessionId) === sessionId) {
      process.stdout.write(`[evt] ${p.type} ${JSON.stringify(p.payload ?? {}).slice(0, 260)}\n`)
    }
    if (method === 'state.updated') {
      process.stdout.write(`[state] ${JSON.stringify(p).slice(0, 200)}\n`)
    }
  })

  const sent = await conn.request('session/send', { sessionId, content: '回复 ok' }, 30_000)
  process.stdout.write(`[diag] send → ${JSON.stringify(sent).slice(0, 160)}\n`)
  await new Promise((r) => setTimeout(r, 25_000))

  // 读会话条目（turn 失败原因通常在此）
  const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
  const entries = db.prepare('SELECT type, data FROM session_entry WHERE session_id = ? ORDER BY rowid').all(sessionId) as { type: string; data: string }[]
  process.stdout.write(`[diag] session_entry ${entries.length} 条\n`)
  for (const e of entries.slice(-8)) process.stdout.write(`  [${e.type}] ${e.data.slice(0, 220)}\n`)
  const parts = db.prepare('SELECT data FROM part WHERE session_id = ? ORDER BY rowid').all(sessionId) as { data: string }[]
  process.stdout.write(`[diag] parts ${parts.length}\n`)
  for (const p of parts.slice(-6)) {
    const d = JSON.parse(p.data) as { type?: string; text?: string; tool?: string; state?: { status?: string; error?: string } }
    process.stdout.write(`  [${d.type}] ${String(d.text ?? d.tool ?? d.state?.status ?? '').slice(0, 120)} ${d.state?.error ? 'ERR:' + d.state.error.slice(0, 80) : ''}\n`)
  }
  db.close()
  await conn.close()
  process.exit(0)
}

main().catch((e) => {
  process.stdout.write(`[diag] 失败: ${String(e).slice(0, 300)}\n`)
  process.exit(1)
})
