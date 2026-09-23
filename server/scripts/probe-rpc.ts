/**
 * relay 阶段二实证探针：完整跑通 认证 → bootstrap → workspace-list → bridge-open → RPC(hello)
 * 并打印所有入站原始字节（hex），用于确定桥接内层封装格式。
 *   node --enable-source-maps scripts/probe-rpc.ts "<配对链接>"
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePairingUrl, RelayClient } from '../src/adapters/zcode-relay/relay-client.ts'

const LOG = path.join(os.homedir(), 'zcode-phone-relay-rpc.log')
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

const url = process.argv[2] ?? ''
const pairing = parsePairingUrl(url)
if (!pairing) {
  P('[rpc] 配对链接非法')
  process.exit(1)
}

let bridgeReady = false
const client = new RelayClient(pairing, {
  onState: (s, d) => {
    P(`[state] ${s}${d ? ' (' + d + ')' : ''}`)
    if (s === 'matched') void run()
  },
  onRawFrame: (bytes) => {
    P(`[raw] ${bytes.length}B head=${bytes.subarray(0, 48).toString('hex')} text=${bytes.subarray(0, 100).toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`)
  },
  onV4Message: (m) => P(`[v4] ${JSON.stringify(m).slice(0, 300)}`),
  onInnerJson: (f) => {
    const zt = String(f.zcode_type ?? '')
    if (zt.includes('degraded') || zt.includes('error')) P(`[inner] ${JSON.stringify(f).slice(0, 240)}`)
  },
  onFault: (c, m) => P(`[fault] ${c} ${m}`),
})

async function run(): Promise<void> {
  P('[rpc] 阶段一：bootstrap')
  await client.requestBootstrap()
  P('[rpc] 阶段一：workspace-list')
  const list = await client.requestWorkspaceList()
  const tasks = ((list?.result as Record<string, unknown> | undefined)?.tasks ?? []) as unknown[]
  P(`[rpc] 任务数=${Array.isArray(tasks) ? tasks.length : '?'}`)
  const key = String(((list?.result as Record<string, unknown> | undefined)?.activeWorkspaceKey as string) ?? '')
  P(`[rpc] 阶段一：bridge-open（${key}）`)
  const bridge = await client.openBridge(key || 'E:\\文件\\编程文件\\zcode phone', undefined)
  bridgeReady = !!bridge
  P(`[rpc] 桥接=${bridgeReady ? 'ready' : 'failed'}`)
  if (!bridgeReady) {
    process.exit(1)
  }
  // 阶段二：helloConversationV4
  P('[rpc] 阶段二：helloConversationV4')
  try {
    const hello = await client.rpcCall('helloConversationV4', undefined, 15_000)
    P(`[rpc] hello → ${JSON.stringify(hello).slice(0, 400)}`)
  } catch (e) {
    P(`[rpc] hello 失败：${String(e).slice(0, 200)}`)
  }
  await new Promise((r) => setTimeout(r, 3000))
  P('[rpc] 结束')
  client.close()
  process.exit(0)
}

client.connect()
setTimeout(() => {
  P(`[rpc] 总超时（bridgeReady=${bridgeReady}）`)
  process.exit(1)
}, 90_000)
