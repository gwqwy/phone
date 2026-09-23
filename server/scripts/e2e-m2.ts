/**
 * M2 控制回路协议级 E2E：
 *   node scripts/e2e-m2.ts
 * 直连 ws://127.0.0.1:3930/ws（回环免密）：
 *   create（test-ws 工作区 + 首条输入）→ 订阅 session-stream → 等待模型执行完成 → 校验产物文件。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

const BASE = process.env.ZPHONE_WS ?? 'ws://127.0.0.1:3930/ws'
const WORKSPACE = 'E:\\文件\\编程文件\\zcode phone\\.data\\test-ws'
const TARGET = path.join(WORKSPACE, 'zphone-m2.txt')

function main(): void {
  const ws = new WebSocket(BASE)
  let reqId = 0
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const request = <T>(method: string, payload?: unknown, timeoutMs = 90_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `e${++reqId}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: (v) => resolve(v as T), reject })
      ws.send(JSON.stringify({ t: 'req', id, method, payload }))
    })

  const sub = (id: string, topic: string, params?: unknown): void => {
    ws.send(JSON.stringify({ t: 'sub', id, topic, params }))
  }

  ws.on('open', async () => {
    try {
      console.log('[e2e] 已连接')

      let done = false
      let sawUser = false
      let sawAssistant = false
      const state = { sessionId: '' }

      // 帧处理必须先挂，再发请求
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { t: string; id?: string; sub?: string; kind?: string; ok?: boolean; data?: unknown; error?: { message?: string }; data2?: { events?: { kind: string; text?: string; status?: string }[] } }
        if (frame.t === 'res') {
          const p = pending.get(String(frame.id))
          if (!p) return
          pending.delete(String(frame.id))
          if (frame.ok) p.resolve(frame.data)
          else p.reject(new Error(frame.error?.message ?? '请求失败'))
          return
        }
        if (frame.t === 'push' && frame.sub === 's1') {
          const events = (frame.data as { events?: { kind: string; text?: string; status?: string }[] })?.events ?? []
          for (const ev of events) {
            console.log(`[frame:${frame.kind}] ${ev.kind} ${String(ev.text ?? '').slice(0, 60)}`)
            if (ev.kind === 'user') sawUser = true
            if (ev.kind === 'text' && ev.status !== 'running') sawAssistant = true
          }
          if (sawUser && sawAssistant && !done) {
            done = true
            setTimeout(() => {
              const ok = existsSync(TARGET) && readFileSync(TARGET, 'utf8').trim() === 'm2-ok'
              console.log(`[e2e] 产物文件校验: ${ok ? '通过' : '未通过'}（${TARGET}）`)
              finish(ok ? 0 : 1)
            }, 3000)
          }
        }
      })

      const created = await request<{ sessionId: string }>('create', {
        workspaceId: WORKSPACE,
        text: '请在当前目录创建一个名为 zphone-m2.txt 的文件，内容为 m2-ok，完成后告诉我。',
      })
      state.sessionId = created.sessionId
      console.log(`[e2e] 创建成功 sessionId=${created.sessionId}`)

      sub('s1', 'session-stream', { sessionId: created.sessionId })
      const deadline = Date.now() + 180_000
      const poll = setInterval(() => {
        if (Date.now() > deadline) {
          console.log('[e2e] 等待超时（180s）')
          finish(1)
        }
      }, 5000)

      function finish(code: number): void {
        clearInterval(poll)
        ws.close()
        process.exit(code)
      }
      void poll
    } catch (e) {
      console.error('[e2e] 失败:', e)
      process.exit(1)
    }
  })

  ws.on('error', (e) => {
    console.error('[e2e] WS 错误', e.message)
    process.exit(1)
  })
}

main()
