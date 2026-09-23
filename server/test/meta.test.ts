import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MetaStore } from '../src/core/meta.ts'

test('MetaStore：写入、读回、落盘、重载', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zp-meta-'))
  try {
    const store = new MetaStore(dir)
    store.set('sess_a', { pinned: true })
    store.set('sess_a', { unread: false })
    store.set('sess_b', { alias: '我的任务' })
    assert.equal(store.get('sess_a').pinned, true)
    assert.equal(store.get('sess_a').unread, false)
    assert.equal(store.get('sess_b').alias, '我的任务')
    assert.equal(store.get('sess_c').pinned, undefined)

    store.flush()
    const raw = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>
    assert.ok(raw['sess_a'])
    assert.ok(raw['sess_b'])

    // 新实例读回
    const store2 = new MetaStore(dir)
    assert.equal(store2.get('sess_a').pinned, true)
    assert.equal(store2.get('sess_b').alias, '我的任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MetaStore：undefined 补丁删除键', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zp-meta2-'))
  try {
    const store = new MetaStore(dir)
    store.set('s', { pinned: true, alias: 'x' })
    const next = store.set('s', { alias: undefined })
    assert.equal(next.pinned, true)
    assert.equal(next.alias, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
