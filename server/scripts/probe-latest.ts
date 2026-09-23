/** 诊断：列出最新会话与其消息/部件数、最近文本 */
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
const rows = db
  .prepare('SELECT id, title, time_created FROM session ORDER BY time_created DESC LIMIT 4')
  .all() as { id: string; title: string | null; time_created: number }[]
for (const s of rows) {
  const m = db.prepare('SELECT COUNT(*) AS c FROM message WHERE session_id = ?').get(s.id) as { c: number }
  const p = db.prepare('SELECT COUNT(*) AS c FROM part WHERE session_id = ?').get(s.id) as { c: number }
  const last = db
    .prepare("SELECT data FROM part WHERE session_id = ? AND data LIKE '%\"type\":\"text\"%' ORDER BY rowid DESC LIMIT 1")
    .get(s.id) as { data: string } | undefined
  const text = last ? (JSON.parse(last.data) as { text?: string }).text?.slice(0, 80) : ''
  console.log(`${s.id.slice(0, 34)} | ${String(s.title).slice(0, 24)} | msgs ${m.c} parts ${p.c} | ${text}`)
}
db.close()
