/** 临时诊断：查 sess_ca394e23 最近 part 的类型分布与文本 */
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true })
const sid = 'sess_ca394e23-5e8b-4d0c-b99a-f3e28f7fbfc1'
const rows = db
  .prepare(
    `SELECT p.rowid AS rid, p.data FROM part p
     WHERE p.session_id = ?
       AND p.rowid > (SELECT MAX(rowid) - 500 FROM part WHERE session_id = ?)
     ORDER BY p.rowid`,
  )
  .all(sid, sid) as { rid: number; data: string }[]
const types: Record<string, number> = {}
const lastTexts: string[] = []
for (const r of rows) {
  try {
    const d = JSON.parse(r.data) as { type?: string; text?: string; tool?: string }
    types[d.type ?? '?'] = (types[d.type ?? '?'] ?? 0) + 1
    if (d.type === 'text' && d.text) lastTexts.push(d.text.slice(0, 60))
  } catch {}
}
console.log('近500个part类型:', JSON.stringify(types))
console.log('最后3条text:', JSON.stringify(lastTexts.slice(-3), null, 1))
db.close()
