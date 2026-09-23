/** 诊断：session.history 对 sess_ca394e23 返回的事件类型分布 */
import WebSocket from 'ws'

const BASE = process.argv[2] ?? 'ws://127.0.0.1:3930/ws'
const ws = new WebSocket(BASE)
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'req', id: 'h1', method: 'session.history', payload: { sessionId: 'sess_ca394e23-5e8b-4d0c-b99a-f3e28f7fbfc1' } }))
})
ws.on('message', (raw) => {
  const f = JSON.parse(String(raw)) as { t: string; id?: string; ok?: boolean; data?: unknown; error?: { message?: string } }
  if (f.t === 'res' && f.id === 'h1') {
    const events = (f.data as { events?: { kind: string; text?: string }[] })?.events ?? []
    const hist: Record<string, number> = {}
    for (const e of events) hist[e.kind] = (hist[e.kind] ?? 0) + 1
    console.log(`事件总数 ${events.length}，分布 ${JSON.stringify(hist)}`)
    const texts = events.filter((e) => e.kind === 'text')
    for (const t of texts.slice(-3)) console.log(`  [text] ${String(t.text).slice(0, 60)}`)
    ws.close()
    process.exit(0)
  }
})
ws.addEventListener('error', () => process.exit(1))
setTimeout(() => {
  console.log('timeout')
  process.exit(1)
}, 60_000)
