/** 模型执行链路探针：create → subscribe → send → 观察事件流与最终状态 */
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
  await conn.start(resolveCommand(), ['app-server', '--stdio', '--surface', 'terminal'], os.homedir(), (line) => console.log(`[stderr] ${line.slice(0, 200)}`))
  conn.onReverseRequest((method, params) => {
    if (method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
    }
    console.log(`[reverse] ${method} keys=${Object.keys(params).join(',')}`)
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      console.log(`  [reverse-params] ${JSON.stringify(params).slice(0, 300)}`)
      return new Promise(() => {}) // 挂住，观察是否需要人工
    }
    return {}
  })

  // 注入账号权益 overlay（basedOn 必须等于 worker 内置目录的 revision，否则账号层被丢弃）
  let builtinRevision = 'unknown'
  try {
    const fs = await import('node:fs')
    const builtinFile = 'C:\\Users\\find\\.zcode\\v2\\runtime\\provider\\windows-x86_64\\3.14.3\\endpoint-78d7c3bef4024722642626fe3669a799\\zcode-builtin.json'
    builtinRevision = String((JSON.parse(fs.readFileSync(builtinFile, 'utf8')) as { revision?: string }).revision ?? 'unknown')
    console.log(`[run] 内置目录 revision = ${builtinRevision}`)
  } catch { /* 读不到则用 unknown */ }
  try {
    const acc = await conn.request(
      'provider/updateAccountConfig',
      {
        revision: String(Date.now()),
        basedOnZCodeBuiltinRevision: builtinRevision,
        providers: {
          'account:bigmodel-individual-coding-plan': {
            access: { type: 'zhipu-account', entitled: true },
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
          },
        },
        states: {
          'account:bigmodel-individual-coding-plan': { availability: 'available', entitled: true, current: true },
        },
      },
      20_000,
    )
    console.log(`[run] account overlay → ${JSON.stringify(acc).slice(0, 140)}`)
  } catch (e) {
    console.log(`[run] account overlay 失败: ${String(e).slice(0, 200)}`)
  }

  const created = (await conn.request(
    'session/create',
    {
      workspace: { workspacePath: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws', workspaceKey: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws' },
      titleGenerationEnabled: true,
      persistence: 'immediate',
      model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } },
    },
    60_000,
  )) as Record<string, unknown>
  console.log(`[run] create 原始响应: ${JSON.stringify(created).slice(0, 400)}`)
  const sessionId = String(
    created?.sessionId ?? (created?.session as Record<string, unknown> | undefined)?.sessionId ?? '',
  )
  console.log(`[run] 创建 ${sessionId}`)

  conn.onAnyNotification((method, params) => {
    if (method === 'session/event') {
      const p = (params ?? {}) as Record<string, unknown>
      if (String(p.sessionId) !== sessionId) return
      console.log(`[evt] ${p.type} ${JSON.stringify(p.payload ?? {}).slice(0, 180)}`)
    } else if (method.startsWith('interaction') || method.startsWith('state')) {
      console.log(`[note] ${method} ${JSON.stringify(params ?? {}).slice(0, 160)}`)
    }
  })

  const sub = await conn.requestUuid('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable', includeSnapshot: true }, 20_000)
  console.log(`[run] subscribe ok ${JSON.stringify(sub).slice(0, 100)}`)

  try {
    const sent = await conn.request('session/send', { sessionId, content: '请在当前目录创建一个名为 zphone-m2.txt 的文件，内容为 m2-ok，完成后告诉我。' }, 30_000)
    console.log(`[run] send → ${JSON.stringify(sent).slice(0, 120)}`)
  } catch (e) {
    console.log(`[run] send 失败: ${String(e).slice(0, 200)}`)
  }

  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 5000))
    const list = (await conn.request('session/list', { sessionIds: [sessionId] }, 15_000)) as { sessions?: Record<string, unknown>[] }
    const s = list?.sessions?.[0]
    console.log(`[status ${(i + 1) * 5}s] ${s ? JSON.stringify({ status: s.status, title: s.title }) : '会话不在列表'}`)
    if (s && (s.status === 'completed' || s.status === 'error' || s.status === 'idle')) break
  }

  const file = 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws\\zphone-m2.txt'
  console.log(`[run] 产物存在: ${existsSync(file)}`)
  await conn.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('[run] 失败:', e)
  process.exit(1)
})
