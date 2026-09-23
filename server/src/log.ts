import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const LOG_MAX = 5 * 1024 * 1024
let logFile: string | null = null

export function initLogFile(dir: string): void {
  logFile = path.join(dir, 'server.log')
}

export type Level = 'info' | 'warn' | 'error'

export function log(level: Level, msg: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra === undefined ? '' : ' ' + safeStr(extra)}`
  console[level === 'error' ? 'error' : 'log'](line)
  if (logFile) {
    try {
      if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) renameSync(logFile, logFile + '.1')
      appendFileSync(logFile, line + '\n')
    } catch {
      // 日志写盘失败不影响服务
    }
  }
}

function safeStr(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const info = (m: string, e?: unknown) => log('info', m, e)
export const warn = (m: string, e?: unknown) => log('warn', m, e)
export const error = (m: string, e?: unknown) => log('error', m, e)
