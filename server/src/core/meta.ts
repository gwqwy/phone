import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface TaskMeta {
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  alias?: string
  readAt?: string
}

/**
 * 任务元数据覆盖层：置顶/归档/未读/别名等「手机端自己的」状态，
 * 按 sessionId 键控存 .data/meta.json，与任何 harness 无关。
 */
export class MetaStore {
  #file: string
  #data: Record<string, TaskMeta> = {}
  #timer: NodeJS.Timeout | null = null

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.#file = path.join(dataDir, 'meta.json')
    if (existsSync(this.#file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
        if (parsed && typeof parsed === 'object') this.#data = parsed as Record<string, TaskMeta>
      } catch {
        // 损坏则重置
      }
    }
  }

  get(sessionId: string): TaskMeta {
    return this.#data[sessionId] ?? {}
  }

  all(): Record<string, TaskMeta> {
    return this.#data
  }

  set(sessionId: string, patch: TaskMeta): TaskMeta {
    const cur = this.#data[sessionId] ?? {}
    const next: TaskMeta = { ...cur, ...patch }
    // undefined 值表示删除该键
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (next as Record<string, unknown>)[k]
    }
    this.#data[sessionId] = next
    this.#scheduleSave()
    return next
  }

  #scheduleSave(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#save()
    }, 300)
  }

  #save(): void {
    const tmp = this.#file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(this.#data, null, 2))
      renameSync(tmp, this.#file)
    } catch {
      // 写盘失败下次再试
    }
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#save()
  }
}
