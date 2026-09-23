/** 只读检查 local_setting 与 session_entry 类型分布 */
import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const src = path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
const dst = path.join(process.cwd(), '.probe', 'db2.sqlite')
copyFileSync(src, dst)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(src + ext)) copyFileSync(src + ext, dst + ext)
}
const db = new DatabaseSync(dst, { readOnly: true })
const ls = db.prepare('SELECT * FROM local_setting LIMIT 20').all()
console.log('local_setting:', JSON.stringify(ls).slice(0, 800))
const t = db.prepare('SELECT type, COUNT(*) AS c FROM session_entry GROUP BY type').all()
console.log('entry types:', JSON.stringify(t))
// 看看 v0.0.1 会话（59ba28f2）的 runtime/model_selection 与 execution_state
const rows = db
  .prepare("SELECT type, data FROM session_entry WHERE session_id = 'sess_59ba28f2-0e0c-4b17-b7d1-67a1c6dbb17d'")
  .all() as { type: string; data: string }[]
for (const r of rows) console.log(`  [${r.type}] ${r.data.slice(0, 200)}`)
db.close()
