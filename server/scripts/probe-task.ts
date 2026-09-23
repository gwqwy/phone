/**
 * 远程任务全链路探针：create（指定模型）→ send → 观察执行与产物。
 *   node scripts/probe-task.ts
 * 日志同时写 stdout 与 ~/zcode-phone-probe-task.log（避免 shell 重定向丢失）。
 */
import os from 'node:os'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AppServerConnection } from '../src/adapters/zcode/connection.ts'

const LOG_FILE = path.join(os.homedir(), 'zcode-phone-probe-task.log')
function L(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  process.stdout.write(line + '\n')
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // 忽略
  }
}
try {
  writeFileSync(LOG_FILE, '')
} catch {
  // 忽略
}

const WORKSPACE = path.resolve(import.meta.dirname, '..', '..', '.data', 'test-ws')
const TARGET = path.join(WORKSPACE, 'zphone-task.txt')
const MODEL = { providerId: 'deepseek', modelId: 'deepseek-v4-pro', options: { reasoningLevel: 'high' } }

function resolveCommand(): string {
  const candidates = ['E:\\zcode\\resources\\glm\\zcode.cjs', path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs')]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('未找到 zcode CLI')
}

async function main(): Promise<void> {
  const conn = new AppServerConnection()
  await conn.start(resolveCommand(), ['app-server', '--stdio'], os.homedir(), (line) => {
    if (/error|fail|429|1310/i.test(line)) L(`[stderr] ${line.slice(0, 220)}`)
  })
  conn.onReverseRequest((method) => {
    if (method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
    }
    return {}
  })

  L(`[task] 工作区 ${WORKSPACE}`)
  L('[task] create（deepseek-v4-pro, reasoning=high）')
  const created = (await conn.request(
    'session/create',
    { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, titleGenerationEnabled: false, persistence: 'immediate', model: MODEL },
    60_000,
  )) as Record<string, unknown>
  const sessionId = String(
    (created.sessionId as string) ?? ((created.session as Record<string, unknown> | undefined)?.sessionId as string) ?? '',
  )
  L(`[task] sessionId=${sessionId}`)

  conn.onAnyNotification((method, params) => {
    if (method !== 'session/event') return
    const p = (params ?? {}) as Record<string, unknown>
    if (String(p.sessionId) !== sessionId) return
    const type = String(p.type)
    if (type === 'turn.completed' || type === 'turn.failed' || type === 'message.upserted') {
      L(`[evt] ${type} ${JSON.stringify(p.payload ?? {}).slice(0, 220)}`)
    }
  })

  const sendRes = await conn.request('session/send', { sessionId, content: '请在当前目录创建 zphone-task.txt，内容为 task-ok。完成后回复一句话。' }, 60_000)
  L(`[task] send → ${JSON.stringify(sendRes).slice(0, 120)}`)

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 6000))
    const list = (await conn.request('session/list', { sessionIds: [sessionId] }, 15_000)) as { sessions?: Record<string, unknown>[] }
    const s = list?.sessions?.[0]
    const exists = existsSync(TARGET)
    L(`[task ${(i + 1) * 6}s] status=${s ? String(s.status) : '?'} 产物=${exists}`)
    if (exists || s?.status === 'completed' || s?.status === 'error') break
  }
  await conn.close()
  L('[task] 结束')
  process.exit(0)
}

main().catch((e) => {
  L(`[task] 失败: ${String(e).slice(0, 400)}`)
  process.exit(1)
})
