import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPairingUrl, isPaired, parsePairingLink, sidSuffix } from '../client/core/pairing-link.js'

const SAMPLE =
  'https://zcode.z.ai/remote/v4?sid=d_TestSid000000000000&hash=AbCdEf123%3D&t=1788059173414' +
  '&mid=00000000-0000-4000-8000-000000000000&name=DESKTOP-ABC123&app_version=3.10.1'

test('解析示例链接的全部字段', () => {
  const endpoint = parsePairingLink(SAMPLE, { id: 'e1', now: 1000 })
  assert.ok(endpoint)
  assert.equal(endpoint.id, 'e1')
  assert.equal(endpoint.kind, 'zcode-relay')
  assert.equal(endpoint.baseUrl, 'https://zcode.z.ai/remote/v4')
  assert.equal(endpoint.params.sid, 'd_TestSid000000000000')
  assert.equal(endpoint.params.hash, 'AbCdEf123=', 'hash 里的 %3D 必须解成 =')
  assert.equal(endpoint.params.app_version, '3.10.1')
  assert.equal(endpoint.label, 'DESKTOP-ABC123', 'name 就是设备名')
  assert.equal(endpoint.createdAt, 1000)
})

test('只接受 http/https，且 sid 与 hash 都必须非空', () => {
  const bad = [
    'zcode://remote?sid=a&hash=b',
    'javascript:alert(1)',
    'https://zcode.z.ai/remote/v4?sid=a',
    'https://zcode.z.ai/remote/v4?hash=b',
    'https://zcode.z.ai/remote/v4?sid=&hash=b',
    '',
    '这不是链接',
  ]
  for (const input of bad) {
    assert.equal(parsePairingLink(input), null, `应拒绝：${input}`)
  }
})

test('未知参数原样保留（桌面端新增字段不能被我们吃掉）', () => {
  const endpoint = parsePairingLink(SAMPLE)
  assert.equal(endpoint.params.mid, '00000000-0000-4000-8000-000000000000')
  const withFuture = parsePairingLink(SAMPLE + '&future=xyz')
  assert.equal(withFuture.params.future, 'xyz')
})

test('自建中继的端口与路径必须保留', () => {
  const endpoint = parsePairingLink('https://relay.example.com:8443/remote/v4?sid=a&hash=b')
  assert.equal(endpoint.baseUrl, 'https://relay.example.com:8443/remote/v4')
})

test('重建时重铸 t，其余参数与编码保持不变', () => {
  const endpoint = parsePairingLink(SAMPLE)
  const url = buildPairingUrl(endpoint, 1700000000000)
  assert.match(url, /[?&]t=1700000000000(&|$)/, 't 必须换成新时间戳')
  assert.ok(url.includes('hash=AbCdEf123%3D'), 'hash 的 = 必须重新编码为 %3D')
  assert.ok(url.includes('sid=d_TestSid000000000000'))
  assert.ok(url.includes('app_version=3.10.1'))
  assert.ok(!url.includes('1788059173414'), '旧时间戳必须被移除')
  assert.equal(url.match(/[?&]t=/g).length, 1, 't 只能出现一次')
})

test('sidSuffix 取末尾 6 位', () => {
  assert.equal(sidSuffix('d_TestSid000000000000'), '000000')
  assert.equal(sidSuffix('abc'), 'abc')
  assert.equal(sidSuffix(''), '')
})

test('isPaired 判定凭据完整性', () => {
  const good = parsePairingLink(SAMPLE)
  assert.equal(isPaired(good), true)
  assert.equal(isPaired({ baseUrl: 'https://h/p', params: { sid: 'a' } }), false)
  assert.equal(isPaired(null), false)
})
