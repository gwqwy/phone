/** 验证模型列表与切换：通过服务 WS 调 models.list / model.set */
import { appendFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const LOG = path.join(os.homedir(), 'zcode-phone-models.log')
try {
  writeFileSync(LOG, '')
} catch {
  // 忽略
}
function P(m: string): void {
  process.stdout.write(m + '\n')
  try {
    appendFileSync(LOG, m + '\n')
  } catch {
    // 忽略
  }
}

const BASE = 'ws://127.0.0.1:3930/ws'
const SESSION = process.argv[2] ?? 'sess_ca394e23-5e8b-4d0c-b99a-f3e28f7fbfc1'

const ws = new WebSocket(BASE)
let seq = 0
const pending = new Map<string, (v: unknown) => void>()

function req<T>(method: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `m${++seq}`
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 40_000)
    pending.set(id, (v) => {
      clearTimeout(timer)
      resolve(v as T)
    })
    ws.send(JSON.stringify({ t: 'req', id, method, payload }))
  })
}

ws.on('message', (raw) => {
  const f = JSON.parse(String(raw)) as { t: string; id?: string; ok?: boolean; data?: unknown; error?: { message?: string } }
  if (f.t !== 'res' || !f.id) return
  const cb = pending.get(f.id)
  if (!cb) return
  pending.delete(f.id)
  if (f.ok) cb(f.data)
  else cb({ __error: f.error?.message ?? 'failed' })
})

ws.on('open', async () => {
  const list = await req<{ models?: { providerId: string; modelId: string; label?: string }[]; current?: unknown; __error?: string }>('models.list', { sessionId: SESSION })
  if (list.__error) {
    P(`[mp] models.list error: ${list.__error}`)
  } else {
    P(`[mp] models=${list.models?.length ?? 0} current=${JSON.stringify(list.current)}`)
    for (const m of (list.models ?? []).slice(0, 10)) P(`   - ${m.providerId}/${m.modelId} (${m.label ?? ''})`)
  }
  const set = await req<{ changed?: boolean; __error?: string }>('model.set', {
    sessionId: SESSION,
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    reasoningLevel: 'high',
  })
  P(`[mp] model.set -> ${JSON.stringify(set)}`)
  const after = await req<{ current?: unknown; __error?: string }>('models.list', { sessionId: SESSION })
  P(`[mp] after current=${JSON.stringify(after.current ?? after.__error)}`)
  ws.close()
  process.exit(0)
})

ws.on('error', (e) => {
  P(`[mp] ws error ${e.message}`)
  process.exit(1)
})
setTimeout(() => {
  P('[mp] overall timeout')
  process.exit(1)
}, 90_000)
