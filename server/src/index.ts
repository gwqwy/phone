import { createServer } from 'node:http'
import { DATA_DIR, lanAddresses, loadConfig, loadOrCreatePin, newSessionKey } from './config.ts'
import { info, initLogFile } from './log.ts'
import { AuthService } from './auth.ts'
import { HarnessRegistry } from './core/harness.ts'
import { MetaStore } from './core/meta.ts'
import { ZcodeAdapter } from './adapters/zcode/index.ts'
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

  const zcode = new ZcodeAdapter(config)
  registry.register(zcode, true)
  zcode
    .start()
    .then(() => registry.notifyIndexChanged())
    .catch((e) => info('[zcode] 启动失败', String(e)))

  const server = createServer(createHandler({ config, auth, registry, version: VERSION }))
  attachWs(server, { auth, registry, meta })

  server.listen(config.port, config.host, () => {
    info(`zcode phone server v${VERSION}`)
    info(`  本机:   http://127.0.0.1:${config.port}`)
    for (const ip of lanAddresses()) info(`  局域网: http://${ip}:${config.port}`)
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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
