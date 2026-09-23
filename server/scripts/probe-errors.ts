/** 诊断：列出最近会话的失败事件（turn.failed / error）与模型调用错误详情 */
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
const sessions = db
  .prepare("SELECT id, title, time_updated FROM session WHERE id NOT LIKE 'sess_subagent%' ORDER BY time_updated DESC LIMIT 5")
  .all() as { id: string; title: string | null; time_updated: number }[]

for (const s of sessions) {
  console.log(`\n=== ${s.id} | ${String(s.title).slice(0, 30)} | ${new Date(s.time_updated).toISOString()}`)
  const entries = db
    .prepare('SELECT type, data FROM session_entry WHERE session_id = ? ORDER BY rowid DESC LIMIT 12')
    .all(s.id) as { type: string; data: string }[]
  for (const e of entries) {
    if (/fail|error|runtime|model/i.test(e.type) || /fail|error/i.test(e.data)) {
      console.log(`  [${e.type}] ${e.data.slice(0, 400)}`)
    }
  }
  const parts = db
    .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 6')
    .all(s.id) as { data: string }[]
  for (const p of parts) {
    const d = JSON.parse(p.data) as { type?: string; text?: string; error?: unknown; state?: { status?: string; error?: string } }
    if (d.error || d.state?.status === 'error' || d.type === 'retry') {
      console.log(`  [part ${d.type}] error=${JSON.stringify(d.error ?? d.state?.error ?? '').slice(0, 300)}`)
    }
  }
}
db.close()
