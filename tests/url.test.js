import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLink, decodeComponent, encodeComponent, isPrivateOrReservedHost, parseLink, toParamsArray, toParamsObject } from '../client/core/url.js'

test('解析基本链接', () => {
  const parsed = parseLink('https://zcode.z.ai/remote/v4?sid=a&hash=b')
  assert.equal(parsed.scheme, 'https')
  assert.equal(parsed.host, 'zcode.z.ai')
  assert.equal(parsed.port, null, '没写端口时必须保持 null，重建时才不会凭空长出 :443')
  assert.equal(parsed.path, '/remote/v4')
  assert.deepEqual(parsed.query, [['sid', 'a'], ['hash', 'b']])
})

test('保留非默认端口与任意路径', () => {
  const parsed = parseLink('https://relay.example.com:8443/remote/v4?sid=a&hash=b')
  assert.equal(parsed.port, 8443)
  assert.equal(buildLink(parsed, toParamsArray(toParamsObject(parsed.query))), 'https://relay.example.com:8443/remote/v4?sid=a&hash=b')
})

test('拒绝非 http(s) 与畸形输入', () => {
  for (const bad of ['', '   ', 'junk', 'zcode://x?sid=a&hash=b', 'javascript:alert(1)', 'ftp://h/x?sid=a', 'https:///remote?sid=a&hash=b']) {
    assert.equal(parseLink(bad), null, `应拒绝：${bad}`)
  }
})

test('查询串解码与浏览器一致（+ 视作空格），编码不用 +', () => {
  assert.equal(decodeComponent('a+b'), 'a b')
  assert.equal(decodeComponent('%3D'), '=')
  assert.equal(encodeComponent(' '), '%20')
  assert.equal(encodeComponent('='), '%3D')
  assert.equal(encodeComponent("!'()*"), '%21%27%28%29%2A')
})

test('空值参数在重建时被丢弃，且不会凭空多出 ?', () => {
  assert.equal(buildLink(parseLink('https://h/p'), []), 'https://h/p')
  assert.equal(buildLink(parseLink('https://h/p'), [['a', ''], ['b', '1']]), 'https://h/p?b=1')
})

test('IPv6 主机解析', () => {
  const parsed = parseLink('http://[::1]:8080/x?sid=a')
  assert.equal(parsed.host, '[::1]')
  assert.equal(parsed.port, 8080)
})

test('私有与保留地址识别', () => {
  const blocked = [
    'localhost',
    'LOCALHOST',
    'app.localhost',
    'foo.local',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.5',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '999.1.1.1',
    '',
  ]
  for (const host of blocked) {
    assert.equal(isPrivateOrReservedHost(host), true, `应判为私有/保留：${host}`)
  }
  const allowed = ['zcode.z.ai', 'example.com', '8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860:4860::8888']
  for (const host of allowed) {
    assert.equal(isPrivateOrReservedHost(host), false, `应判为公网：${host}`)
  }
})
