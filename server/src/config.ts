import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, randomInt } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { info, warn } from './log.ts'

const SERVER_ROOT = path.resolve(import.meta.dirname, '..')
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')
export const DATA_DIR = process.env.ZPHONE_DATA
  ? path.resolve(process.env.ZPHONE_DATA)
  : path.join(PROJECT_ROOT, '.data')

export interface AppConfig {
  port: number
  host: string
  clientDist: string
  /** zcode CLI 路径；留空则自动探测（桌面端内置 glm/zcode.cjs 或 PATH 中的 zcode） */
  zcodeCommand: string
  /** app-server 的工作目录（决定其读取的存储），默认用户主目录 */
  zcodeCwd: string
}

const DEFAULTS: AppConfig = {
  port: 3930,
  host: '0.0.0.0',
  clientDist: path.join(PROJECT_ROOT, 'client', 'dist', 'build', 'h5'),
  zcodeCommand: '',
  zcodeCwd: '',
}

export function loadConfig(): AppConfig {
  mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, 'config.json')
  let user: Partial<AppConfig> = {}
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
    } catch (e) {
      warn('config.json 解析失败，使用默认配置', e)
    }
  } else {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n')
    info('已生成默认配置', file)
  }
  return { ...DEFAULTS, ...user }
}

/** 8 位数字 PIN，CSPRNG 生成，存 .data/pin */
export function loadOrCreatePin(): string {
  const file = path.join(DATA_DIR, 'pin')
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim()
    if (/^\S{6,64}$/.test(v)) return v
  }
  const pin = String(randomInt(10_000_000, 100_000_000))
  writeFileSync(file, pin + '\n', { mode: 0o600 })
  return pin
}

/** 每次启动随机的进程级会话密钥：认证 cookie 绑定它，重启即全体重新登录 */
export function newSessionKey(): string {
  return randomBytes(16).toString('hex')
}

/** 取局域网 IPv4（优先 RFC1918 私网），用于控制台展示访问地址 */
export function lanAddresses(): string[] {
  const out: string[] = []
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const it of list ?? []) {
      if (it.family !== 'IPv4' || it.internal) continue
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(it.address)
      if (isPrivate) out.unshift(it.address)
      else out.push(it.address)
    }
  }
  return [...new Set(out)]
}
