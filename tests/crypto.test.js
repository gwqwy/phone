import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64, base64Decode, hmacSha256, sha256, utf8 } from '../client/core/crypto.js'

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

test('SHA-256 命中标准测试向量', () => {
  assert.equal(
    hex(sha256(utf8(''))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert.equal(
    hex(sha256(utf8('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  // 跨块边界（长度 56 会触发第二块）
  assert.equal(
    hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
})

test('SHA-256 处理多字节字符与超长输入', () => {
  // 中文按 UTF-8 编码后再摘要，长度必须按字节算而不是按字符算
  assert.equal(hex(sha256(utf8('中文'))), hex(sha256(new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]))))
  const long = 'a'.repeat(1000)
  assert.equal(hex(sha256(utf8(long))).length, 64)
})

test('HMAC-SHA256 命中标准测试向量', () => {
  assert.equal(
    hex(hmacSha256(utf8('key'), utf8('The quick brown fox jumps over the lazy dog'))),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  )
  // RFC 4231 用例 2：key = "Jefe"
  assert.equal(
    hex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  )
  // RFC 4231 用例 6：key 是 131 个 0xaa 字节，超过分组长度，必须先被摘要
  assert.equal(
    hex(hmacSha256(new Uint8Array(131).fill(0xaa), utf8('Test Using Larger Than Block-Size Key - Hash Key First'))),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  )
})

test('base64url 不带填充，且能解码回来', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x2b])
  const encoded = base64(bytes, true)
  assert.ok(!encoded.includes('='), 'url-safe 形态不能带填充')
  assert.ok(!/[+/]/.test(encoded), 'url-safe 形态不能出现 + /')
  assert.deepEqual([...base64Decode(encoded)], [...bytes])
})

test('base64 标准形态带填充', () => {
  assert.equal(base64(new Uint8Array([0x66])), 'Zg==')
  assert.equal(base64(new Uint8Array([0x66, 0x6f])), 'Zm8=')
  assert.equal(base64(new Uint8Array([0x66, 0x6f, 0x6f])), 'Zm9v')
})
