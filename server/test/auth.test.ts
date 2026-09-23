import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyHost, classifySource, effectiveLevel, AuthService } from '../src/auth.ts'

test('classifyHost：回环/局域网/公网', () => {
  assert.equal(classifyHost('localhost:3930'), 'loopback')
  assert.equal(classifyHost('127.0.0.1:3930'), 'loopback')
  assert.equal(classifyHost('[::1]:3930'), 'loopback')
  assert.equal(classifyHost('192.168.1.20:3930'), 'lan')
  assert.equal(classifyHost('10.3.46.149:3930'), 'lan')
  assert.equal(classifyHost('172.16.0.9:3930'), 'lan')
  assert.equal(classifyHost('100.100.1.2:3930'), 'lan') // CGNAT
  assert.equal(classifyHost('DESKTOP-I89B3RF:3930'), 'lan') // 单标签主机名
  assert.equal(classifyHost('mybox.local:3930'), 'lan') // mDNS
  assert.equal(classifyHost('pocket.example.com:443'), 'public') // 公网域名一律最严
  assert.equal(classifyHost('8.8.8.8:3930'), 'public')
  assert.equal(classifyHost(undefined), 'public')
})

test('classifySource 与 effectiveLevel（只收紧不放松）', () => {
  assert.equal(classifySource('127.0.0.1'), 'loopback')
  assert.equal(classifySource('::ffff:192.168.1.5'), 'lan')
  assert.equal(classifySource('203.0.113.9'), 'public')
  // Host 声称 loopback，但源是公网 → 用源地址
  assert.equal(effectiveLevel('127.0.0.1:3930', '203.0.113.9'), 'public')
  // Host 声称公网，但源是回环 → 取 Host 的更宽级别？不——源更严应覆盖为 loopback 之上更严者
  // 语义：取两者中更严的级别（数字更大）
  assert.equal(effectiveLevel('pocket.example.com', '127.0.0.1'), 'public')
  assert.equal(effectiveLevel('localhost:3930', '192.168.1.5'), 'lan')
})

test('AuthService：cookie 校验（常量时间比较）', () => {
  const auth = new AuthService('12345678', 'session-key-1')
  const token = auth.token()
  const good = { headers: { cookie: `zphone_token=${token}` } }
  const bad = { headers: { cookie: 'zphone_token=deadbeef' } }
  const none = { headers: {} }
  assert.equal(auth.check(good as never, 'lan'), true)
  assert.equal(auth.check(bad as never, 'lan'), false)
  assert.equal(auth.check(none as never, 'lan'), false)
  // 回环免密
  assert.equal(auth.check(none as never, 'loopback'), true)
  // 重启换 sessionKey 后旧 cookie 失效
  const auth2 = new AuthService('12345678', 'session-key-2')
  assert.equal(auth2.check(good as never, 'lan'), false)
})
