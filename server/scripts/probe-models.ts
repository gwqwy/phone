/** 探测 registry 中哪些模型可用：逐个 testModelConnectivity */
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
  const ws = { workspacePath: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws', workspaceKey: 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws' }
  const candidates = process.argv.slice(2)
  for (const spec of candidates) {
    const [providerId, modelId] = spec.split('/')
    try {
      const r = await conn.request('provider/testModelConnectivity', { workspace: ws, selection: { providerId, modelId } }, 25_000)
      console.log(`✅ ${spec} → ${JSON.stringify(r).slice(0, 80)}`)
    } catch (e) {
      console.log(`❌ ${spec} → ${String(e).slice(0, 160)}`)
    }
  }
  await conn.close()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
