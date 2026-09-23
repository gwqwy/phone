/** 查会话最近消息（判断用户发送是否到达）：node scripts/probe-msgs.ts <sessionId> */
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const sid = process.argv[2] ?? 'sess_ca394e23-5e8b-4d0c-b99a-f3e28f7fbfc1'
const db = new DatabaseSync(path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
const rows = db
  .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 6')
  .all(sid) as { id: string; time_created: number; data: string }[]
console.log(`最近 ${rows.length} 条消息：`)
for (const r of rows) {
  const info = JSON.parse(r.data) as { role?: string; error?: { message?: string } }
  const firstPart = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid LIMIT 1').get(r.id) as { data: string } | undefined
  let text = ''
  if (firstPart) {
    const p = JSON.parse(firstPart.data) as { type?: string; text?: string }
    text = String(p.text ?? p.type ?? '').slice(0, 40)
  }
  console.log(`  ${new Date(r.time_created).toISOString()} [${info.role}] ${text}${info.error ? ' ERR=' + String(info.error.message).slice(0, 80) : ''}`)
}
db.close()
