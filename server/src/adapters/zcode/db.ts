import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TimelineEvent } from '../../protocol.ts'
import { messageToEvents, type ZcodeMessageInfo, type ZcodeMessageWithParts, type ZcodePart } from './map.ts'
import { warn } from '../../log.ts'

export interface SessionRow {
  id: string
  directory: string | null
  title: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
}

interface MessageRow {
  id: string
  data: string
}

interface PartRow {
  rowid: number
  message_id: string
  data: string
}

/**
 * 直读 ~/.zcode/cli/db/db.sqlite（只读）。
 * 原因：app-server 的 session/read|resume 对旧会话会因 runtime 偏好缺字段而失败（0.16.9），
 * 而 message/part 行的 data JSON 与 contracts 的 MessageInfo/MessagePart 形状一致，直接映射即可。
 */
export class ZcodeDbReader {
  #db: DatabaseSync | null = null
  #path: string

  constructor(dbPath?: string) {
    this.#path = dbPath ?? path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  }

  get available(): boolean {
    return this.#db !== null
  }

  open(): boolean {
    if (this.#db) return true
    if (!existsSync(this.#path)) return false
    try {
      this.#db = new DatabaseSync(this.#path, { readOnly: true })
      return true
    } catch (e) {
      warn(`[zcode] 打开 SQLite 失败：${String(e).slice(0, 120)}`)
      return false
    }
  }

  close(): void {
    try {
      this.#db?.close()
    } catch {
      // 已关闭
    }
    this.#db = null
  }

  private ensure(): DatabaseSync | null {
    if (this.#db) return this.#db
    return this.open() ? this.#db : null
  }

  private query<T>(sql: string, ...params: (string | number)[]): T[] | null {
    const db = this.ensure()
    if (!db) return null
    try {
      return db.prepare(sql).all(...params) as T[]
    } catch (e) {
      warn(`[zcode] SQLite 查询失败：${String(e).slice(0, 120)}`)
      // 连接可能因文件被替换而失效，重开一次
      this.close()
      return null
    }
  }

  sessions(limit = 200): SessionRow[] {
    const rows = this.query<SessionRow>(
      `SELECT id, directory, title, time_created, time_updated, time_archived,
              summary_additions, summary_deletions, summary_files
       FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`,
      limit,
    )
    return rows ?? []
  }

  /** 会话时间线：消息+部件 → 统一事件 */
  history(sessionId: string, messageLimit = 400): TimelineEvent[] {
    const messages = this.query<MessageRow>(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT ?',
      sessionId,
      messageLimit,
    )
    if (!messages || messages.length === 0) return []
    const ids = messages.map((m) => m.id)
    const placeholders = ids.map(() => '?').join(',')
    const parts = this.query<PartRow>(
      `SELECT rowid, message_id, data FROM part WHERE message_id IN (${placeholders}) ORDER BY rowid ASC`,
      ...ids,
    ) ?? []
    const byMessage = new Map<string, ZcodePart[]>()
    for (const p of parts) {
      try {
        const list = byMessage.get(p.message_id) ?? []
        list.push(JSON.parse(p.data) as ZcodePart)
        byMessage.set(p.message_id, list)
      } catch {
        // 跳过坏行
      }
    }
    const out: TimelineEvent[] = []
    // messages 是倒序取的，回正
    for (const m of [...messages].reverse()) {
      const info = safeParse<ZcodeMessageInfo>(m.data)
      const msg: ZcodeMessageWithParts = { info: { ...(info ?? {}), id: m.id }, parts: byMessage.get(m.id) ?? [] }
      out.push(...messageToEvents(msg))
    }
    return out
  }

  maxPartRowId(sessionId: string): number {
    const rows = this.query<{ m: number | null }>('SELECT MAX(rowid) AS m FROM part WHERE session_id = ?', sessionId)
    return rows?.[0]?.m ?? 0
  }

  /** 轮询增量：比 sinceRowId 新的部件（带消息角色） */
  partsSince(sessionId: string, sinceRowId: number): { rowid: number; event: TimelineEvent }[] {
    const rows = this.query<{ rowid: number; message_id: string; data: string; mdata: string }>(
      `SELECT p.rowid AS rowid, p.message_id AS message_id, p.data AS data, m.data AS mdata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND p.rowid > ? ORDER BY p.rowid ASC LIMIT 200`,
      sessionId,
      sinceRowId,
    )
    if (!rows) return []
    const out: { rowid: number; event: TimelineEvent }[] = []
    for (const r of rows) {
      try {
        const part = JSON.parse(r.data) as ZcodePart
        const info = safeParse<ZcodeMessageInfo>(r.mdata)
        const ev = messageToEvents({ info: { ...(info ?? {}), id: r.message_id }, parts: [part] })
        for (const e of ev) out.push({ rowid: r.rowid, event: e })
      } catch {
        // 跳过坏行
      }
    }
    return out
  }
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
