/**
 * SQLite 直读探测（开发用）：复制 ~/.zcode/cli/db/db.sqlite 到临时位置后只读检查表结构与样例。
 *   node scripts/probe-db.ts
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const src = path.join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
const dir = path.join(process.cwd(), '.probe')
mkdirSync(dir, { recursive: true })
const dst = path.join(dir, 'db.sqlite')
copyFileSync(src, dst)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(src + ext)) copyFileSync(src + ext, dst + ext)
}
console.log(`[db] 已复制 ${statSync(dst).size} 字节`)

const db = new DatabaseSync(dst, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
console.log(`[db] 表: ${tables.map((t) => t.name).join(', ')}`)

for (const t of ['session', 'message', 'part', 'session_entry']) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all() as { c: number }[])[0]?.c
    console.log(`\n[${t}] ${count} 行，列: ${cols.map((c) => c.name + ':' + c.type).join(', ')}`)
  } catch (e) {
    console.log(`\n[${t}] 不存在或查询失败: ${String(e).slice(0, 80)}`)
  }
}

// 样例：一个 session 的 entry 类型分布 + message/part 样例
const sid = (db.prepare('SELECT id FROM session ORDER BY time_updated DESC LIMIT 1').all() as { id: string }[])[0]?.id
if (sid) {
  console.log(`\n[样例会话] ${sid}`)
  try {
    const entries = db.prepare('SELECT type, COUNT(*) AS c FROM session_entry WHERE session_id = ? GROUP BY type').all(sid) as { type: string; c: number }[]
    console.log(`[session_entry 类型] ${JSON.stringify(entries)}`)
    const e1 = db.prepare('SELECT type, data FROM session_entry WHERE session_id = ? LIMIT 5').all(sid) as { type: string; data: string }[]
    for (const e of e1) console.log(`  entry[${e.type}] ${e.data.slice(0, 220)}`)
  } catch (e) {
    console.log(`  entry 查询失败: ${String(e).slice(0, 100)}`)
  }
  const msgs = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created LIMIT 3').all(sid) as { id: string; data: string }[]
  console.log(`[message 样例] ${msgs.length} 条`)
  for (const m of msgs) console.log(`  ${m.data.slice(0, 260)}`)
  const parts = db.prepare('SELECT data FROM part WHERE session_id = ? ORDER BY rowid LIMIT 6').all(sid) as { data: string }[]
  console.log(`[part 样例] ${parts.length} 条`)
  for (const p of parts) console.log(`  ${p.data.slice(0, 260)}`)
}
db.close()
