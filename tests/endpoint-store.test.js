import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEndpointStore } from '../client/core/endpoint-store.js'
import { createMemoryStorage } from '../client/core/storage.js'

const RELAY_A = 'https://zcode.z.ai/remote/v4?sid=sidAAA&hash=h1&name=电脑A'
const RELAY_A_AGAIN = 'https://zcode.z.ai/remote/v4?sid=sidAAA&hash=h2&name=电脑A'
const RELAY_B = 'https://zcode.z.ai/remote/v4?sid=sidBBB&hash=h3&name=电脑B'
const DSH_PC = 'http://192.168.1.9:3081/?token=lan12345'
const DSH_LOCAL = 'http://127.0.0.1:3080/'

function fresh() {
  return createEndpointStore(createMemoryStorage())
}

test('导入成功后可按顺序列出', () => {
  const store = fresh()
  assert.equal(store.import(RELAY_A, { id: 'a' }).status, 'added')
  assert.equal(store.import(DSH_PC, { id: 'b' }).status, 'added')
  assert.equal(store.import(DSH_LOCAL, { id: 'c' }).status, 'added')
  assert.deepEqual(store.list().map((e) => e.id), ['a', 'b', 'c'])
})

test('非法输入不写任何东西', () => {
  const store = fresh()
  assert.equal(store.import('乱七八糟').status, 'invalid')
  assert.deepEqual(store.list(), [])
})

test('同 sid 再次导入判为重复，并把既有端点交回', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a' })
  const result = store.import(RELAY_A_AGAIN, { id: 'a2' })
  assert.equal(result.status, 'duplicate')
  assert.equal(result.existing.id, 'a')
  assert.equal(store.list().length, 1, '不能产生第二张卡')
})

test('dsh 端点按地址去重，密码不同也算同一台', () => {
  const store = fresh()
  store.import(DSH_PC, { id: 'a' })
  const again = store.import('http://192.168.1.9:3081/?token=zzzz9999', { id: 'a2' })
  assert.equal(again.status, 'duplicate')
  assert.equal(store.list().length, 1)
})

test('不同 kind 的同名参数互不干扰', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a' })
  store.import(DSH_PC, { id: 'b' })
  assert.equal(store.list().length, 2)
})

test('换链接保留 id、创建时间与已有名字，位置不变', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a', now: 111 })
  store.import(RELAY_B, { id: 'b', now: 222 })
  const renamed = store.rename('a', '我的主力机')
  assert.equal(renamed.label, '我的主力机')

  const replaced = store.replaceLink('a', RELAY_A_AGAIN, { now: 999 })
  assert.equal(replaced.id, 'a')
  assert.equal(replaced.createdAt, 111, '创建时间不能变')
  assert.equal(replaced.label, '我的主力机', '用户起的名字优先于链接里的 name')
  assert.equal(replaced.params.hash, 'h2', '凭据必须是新的')
  assert.deepEqual(store.list().map((e) => e.id), ['a', 'b'], '顺序不变')
})

test('没起过名字的端点在换链接时采用新链接里的 name', () => {
  const store = fresh()
  store.import('https://zcode.z.ai/remote/v4?sid=sidCCC&hash=h9', { id: 'c' })
  const replaced = store.replaceLink('c', 'https://zcode.z.ai/remote/v4?sid=sidCCC&hash=h10&name=新名字')
  assert.equal(replaced.label, '新名字')
})

test('换 dsh 链接时新链接没带密码则沿用旧的', () => {
  const store = fresh()
  store.import(DSH_PC, { id: 'd' })
  const replaced = store.replaceLink('d', 'http://192.168.1.9:3081/')
  assert.equal(replaced.pin, 'lan12345')
})

test('替换不存在的 id 是无操作', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a' })
  assert.equal(store.replaceLink('nope', RELAY_B), null)
  assert.equal(store.list().length, 1)
})

test('重排拒绝丢 id / 重复 / 未知 id 的顺序，保序写入合法顺序', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a' })
  store.import(RELAY_B, { id: 'b' })
  store.import(DSH_PC, { id: 'c' })

  assert.equal(store.reorder(['a', 'b']), false, '少了一个 id')
  assert.equal(store.reorder(['a', 'b', 'b']), false, '重复 id')
  assert.equal(store.reorder(['a', 'b', 'zzz']), false, '未知 id')
  assert.deepEqual(store.list().map((e) => e.id), ['a', 'b', 'c'], '拒绝后顺序必须原样')

  assert.equal(store.reorder(['c', 'a', 'b']), true)
  assert.deepEqual(store.list().map((e) => e.id), ['c', 'a', 'b'])
})

test('删除同时清理顺序与"上次停留"', () => {
  const store = fresh()
  store.import(RELAY_A, { id: 'a' })
  store.import(RELAY_B, { id: 'b' })
  store.touchLast('a')
  assert.equal(store.lastEndpointId(), 'a')

  assert.equal(store.remove('a'), true)
  assert.deepEqual(store.list().map((e) => e.id), ['b'])
  assert.equal(store.lastEndpointId(), '', '删掉的端点不能继续作为恢复目标')
  assert.equal(store.remove('a'), false, '重复删除无效')
})

test('索引里指向已消失记录的 id 被静默跳过', () => {
  const storage = createMemoryStorage()
  const store = createEndpointStore(storage)
  store.import(RELAY_A, { id: 'a' })
  storage.remove('shou.endpoint.a')
  assert.deepEqual(store.list(), [])
})

test('describe 给出卡片副标题', () => {
  const store = fresh()
  const relay = store.import(RELAY_A, { id: 'a' }).endpoint
  assert.equal(store.describe(relay), 'sid …sidAAA')
  const dsh = store.import(DSH_PC, { id: 'b' }).endpoint
  assert.equal(store.describe(dsh), '192.168.1.9:3081')
})
