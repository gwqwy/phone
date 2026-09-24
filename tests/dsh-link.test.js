import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDshUrl, classifyOrigin, dshIdentity, parseDshLink } from '../client/core/dsh-link.js'

test('来源分级', () => {
  assert.equal(classifyOrigin('127.0.0.1'), 'local')
  assert.equal(classifyOrigin('localhost'), 'local')
  assert.equal(classifyOrigin('[::1]'), 'local')
  assert.equal(classifyOrigin('192.168.1.9'), 'lan')
  assert.equal(classifyOrigin('10.0.0.4'), 'lan')
  assert.equal(classifyOrigin('100.101.102.103'), 'lan', 'CGNAT 网段按局域网处理')
  assert.equal(classifyOrigin('pocket.example.com'), 'public')
  assert.equal(classifyOrigin('abc-xyz.trycloudflare.com'), 'public')
})

test('局域网地址解析：token 单独存为密码，不留在参数里', () => {
  const endpoint = parseDshLink('http://192.168.1.9:3081/?token=12345678&name=书房电脑')
  assert.ok(endpoint)
  assert.equal(endpoint.kind, 'dsh-panel')
  assert.equal(endpoint.origin, 'lan')
  assert.equal(endpoint.pin, '12345678')
  assert.equal(endpoint.params.token, undefined, 'token 不能同时留在 params 里')
  assert.equal(endpoint.params.name, '书房电脑')
  assert.equal(endpoint.label, '书房电脑')
})

test('本机地址给出可读的默认名字', () => {
  const endpoint = parseDshLink('http://127.0.0.1:3080/')
  assert.equal(endpoint.origin, 'local')
  assert.equal(endpoint.label, '本机 dsh')
})

test('拒绝非 http(s) 与畸形地址', () => {
  for (const bad of ['', 'junk', 'ws://x/y', 'ssh://h', 'http:///p']) {
    assert.equal(parseDshLink(bad), null, `应拒绝：${bad}`)
  }
})

test('重建地址时按需带上密码', () => {
  const endpoint = parseDshLink('https://pocket.example.com/?token=abcd1234')
  assert.equal(buildDshUrl(endpoint), 'https://pocket.example.com/?token=abcd1234')
  assert.equal(buildDshUrl(endpoint, { withPin: false }), 'https://pocket.example.com/')
})

test('身份键忽略密码差异，同一台 dsh 的不同链接视为同一台', () => {
  const a = parseDshLink('http://192.168.1.9:3081/?token=aaaa1111')
  const b = parseDshLink('http://192.168.1.9:3081/?token=bbbb2222')
  assert.equal(dshIdentity(a), dshIdentity(b))
  const other = parseDshLink('http://192.168.1.9:3082/')
  assert.notEqual(dshIdentity(a), dshIdentity(other), '端口不同就是不同实例')
})
