/**
 * 官方中继直连探针：用配对链接参数连接 wss://zcode.z.ai/ws，
 * 走 auth_init → auth_challenge → auth_response(HMAC proof) → auth_ack，
 * 然后把 data 帧原样打印，确认能否拿到桌面端的 v4 流。
 *
 *   node scripts/probe-relay.ts "<remote/v4 完整链接>"
 *
 * 仅允许 zcode.z.ai / zcode.chatglm.site 两个官方中继主机（https/wss）。
 */
import { createHmac } from 'node:crypto'

const ALLOWED_HOSTS = new Set(['zcode.z.ai', 'zcode.chatglm.site'])

function parsePairing(urlStr: string): { wsUrl: string; deviceSid: string; passHash: string; timestamp: number; deviceMid?: string; deviceName?: string; appVersion?: string } | null {
  const u = new URL(urlStr)
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null
  const deviceSid = u.searchParams.get('sid') ?? ''
  const passHash = u.searchParams.get('hash') ?? ''
  const timestamp = Number(u.searchParams.get('t') ?? NaN)
  if (!deviceSid || !passHash || !Number.isFinite(timestamp)) return null
  return {
    wsUrl: 'wss://zcode.z.ai/ws',
    deviceSid,
    passHash,
    timestamp,
    deviceMid: u.searchParams.get('mid') ?? undefined,
    deviceName: u.searchParams.get('name') ?? undefined,
    appVersion: u.searchParams.get('app_version') ?? undefined,
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function proof(passHash: string, nonce: string, role: string, deviceSid: string): string {
  return b64url(createHmac('sha256', passHash).update(`${nonce}|${role}|${deviceSid}`).digest())
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (!arg) throw new Error('用法：node scripts/probe-relay.ts "<配对链接>"')
  const p = parsePairing(arg)
  if (!p) throw new Error('链接非法或主机不在白名单（仅允许官方中继）')
  console.log(`[relay] 目标 ${p.wsUrl}，deviceSid=${p.deviceSid.slice(0, 8)}…，deviceName=${p.deviceName ?? '-'}`)

  const ws = new WebSocket(p.wsUrl)
  let sawAck = false
  let dataFrames = 0
  const started = Date.now()

  ws.addEventListener('open', () => {
    console.log('[relay] WS 已打开，发送 auth_init（role=terminal）')
    ws.send(JSON.stringify({
      type: 'auth_init',
      role: 'terminal',
      device_sid: p.deviceSid,
      meta: { platform: 'web', version: p.appVersion ?? 'web', name: 'mobile-browser' },
      client_ts: Date.now(),
    }))
  })

  ws.addEventListener('message', async (ev) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(ev.data)) as Record<string, unknown>
    } catch {
      console.log('[recv] 非JSON帧', String(ev.data).slice(0, 120))
      return
    }
    const type = String(frame.type ?? '')
    if (type === 'auth_challenge') {
      const nonce = String(frame.nonce ?? '')
      console.log(`[recv] auth_challenge nonce=${nonce.slice(0, 12)}…`)
      ws.send(JSON.stringify({
        type: 'auth_response',
        device_sid: p.deviceSid,
        proof: proof(p.passHash, nonce, 'terminal', p.deviceSid),
        client_ts: Date.now(),
      }))
      console.log('[send] auth_response（HMAC-SHA256 proof）')
      return
    }
    if (type === 'auth_ack' || type === 'pair_status_ack') {
      sawAck = true
      console.log(`[recv] ${type} pair_status=${JSON.stringify(frame.pair_status)}`)
      return
    }
    if (type === 'data') {
      dataFrames += 1
      const payload = frame.payload
      const brief = typeof payload === 'string' ? payload.slice(0, 300) : JSON.stringify(payload)?.slice(0, 300)
      if (dataFrames <= 8) console.log(`[recv data #${dataFrames}] ${brief}`)
      else if (dataFrames % 20 === 0) console.log(`[recv data] 已收 ${dataFrames} 帧…`)
      return
    }
    if (type === 'error') {
      console.log(`[recv error] code=${frame.code} message=${frame.message}`)
      return
    }
    console.log(`[recv ${type || 'unknown'}] ${JSON.stringify(frame).slice(0, 200)}`)
  })

  ws.addEventListener('close', (ev) => {
    console.log(`[relay] 关闭 code=${ev.code} reason=${ev.reason || '-'}（收到 ack=${sawAck}，data=${dataFrames} 帧，历时 ${Math.round((Date.now() - started) / 1000)}s）`)
    process.exit(0)
  })
  ws.addEventListener('error', (e) => {
    console.log('[relay] WS 错误', (e as ErrorEvent).message ?? '')
  })

  // 对照实验：仅当 --query 时才发 pair_status_query（上次 10s 处被 KICKED）
  const queryTimer = process.argv.includes('--query')
    ? setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'pair_status_query', device_sid: p.deviceSid, client_ts: Date.now() }))
        }
      }, 10_000)
    : null
  setTimeout(() => {
    if (queryTimer) clearInterval(queryTimer)
    console.log(`[relay] 观察结束：ack=${sawAck}，data=${dataFrames} 帧`)
    ws.close()
    process.exit(0)
  }, 60_000)
}

main().catch((e) => {
  console.error('[relay] 失败:', e)
  process.exit(1)
})
