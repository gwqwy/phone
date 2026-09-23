/** 查指定会话的失败详情：node scripts/probe-one.ts <sessionId> */
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const sid = process.argv[2] ?? ''
const db = new DatabaseSync(path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })

const parts = db
  .prepare('SELECT rowid, data FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 40')
  .all(sid) as { rowid: number; data: string }[]
console.log(`parts(最近40) ${parts.length}`)
for (const p of parts.reverse()) {
  const d = JSON.parse(p.data) as {
    type?: string
    text?: string
    tool?: string
    attempt?: number
    error?: { code?: string; message?: string; detail?: string }
    state?: { status?: string; error?: string }
  }
  const err = d.error ?? d.state?.error
  const line = `  [${d.type}] ${String(d.text ?? d.tool ?? d.state?.status ?? '').slice(0, 90)}`
  console.log(err ? `${line}  ERR=${JSON.stringify(err).slice(0, 320)}` : line)
}

const entries = db
  .prepare("SELECT type, data FROM session_entry WHERE session_id = ? AND (type LIKE '%error%' OR type LIKE '%turn%' OR data LIKE '%\"error\"%') ORDER BY rowid DESC LIMIT 10")
  .all(sid) as { type: string; data: string }[]
console.log(`\n相关 entry ${entries.length}`)
for (const e of entries) console.log(`  [${e.type}] ${e.data.slice(0, 400)}`)
db.close()
