import { createServer } from 'node:http'
import { DATA_DIR, lanAddresses, loadConfig, loadOrCreatePin, newSessionKey } from './config.ts'
import { error, info, initLogFile, warn } from './log.ts'
import { AuthService } from './auth.ts'
import { HarnessRegistry } from './core/harness.ts'
import { MetaStore } from './core/meta.ts'
import { ZcodeAdapter } from './adapters/zcode/index.ts'
import { ZcodeRelayAdapter } from './adapters/zcode-relay/index.ts'
import { createHandler } from './http.ts'
import { attachWs } from './ws.ts'

const VERSION = '0.1.0'

async function main(): Promise<void> {
  const config = loadConfig()
  initLogFile(DATA_DIR)
  const pin = loadOrCreatePin()
  const auth = new AuthService(pin, newSessionKey())
  const registry = new HarnessRegistry()
  const meta = new MetaStore(DATA_DIR)

  const zcode = new ZcodeAdapter(config, () => registry.notifyIndexChanged())
  registry.register(zcode, true)
  zcode
    .start()
    .then(() => registry.notifyIndexChanged())
    .catch((e) => info('[zcode] 启动失败', String(e)))

  // 官方中继直连（进行中）：配置了配对链接才启用
  if (config.relayPairingUrl.trim()) {
    const relay = new ZcodeRelayAdapter(config, () => registry.notifyIndexChanged())
    registry.register(relay)
    relay.start().catch((e) => info('[relay] 启动失败', String(e)))
  }

  const server = createServer(createHandler({ config, auth, registry, version: VERSION }))
  attachWs(server, { auth, registry, meta })

  // 端口被占（比如双开了服务）自动 +1 顺延，最多 10 次
  let boundPort = config.port
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && boundPort < config.port + 10) {
      warn(`端口 ${boundPort} 被占用，尝试 ${boundPort + 1}`)
      boundPort += 1
      server.listen(boundPort, config.host)
    } else {
      error(`服务监听失败：${e.message}`)
      process.exit(1)
    }
  })

  server.listen(config.port, config.host, () => {
    info(`zcode phone server v${VERSION}`)
    info(`  本机:   http://127.0.0.1:${boundPort}`)
    for (const ip of lanAddresses()) info(`  局域网: http://${ip}:${boundPort}`)
    info(`  PIN: ${pin}   （数据目录 ${DATA_DIR}）`)
  })

  const shutdown = (): void => {
    void registry.shutdown().then(() => {
      meta.flush()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // 协议异常的兜底：记录但不让整个服务进程退出
  process.on('unhandledRejection', (reason) => {
    warn('未处理的 Promise 拒绝（已兜底）', String(reason))
  })
  process.on('uncaughtException', (err) => {
    warn('未捕获异常（已兜底）', String(err?.stack ?? err))
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
