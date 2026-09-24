import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relayWsUrl } from '../client/api/relay-client.js'
import { parsePairingLink } from '../client/core/pairing-link.js'

/**
 * 中继的 WebSocket 地址必须从配对链接推出来，而不是写死官方域名——
 * 否则自建中继（链接里带端口/自定义域名）会连到错误的服务器上。
 */

const endpointOf = (url) => parsePairingLink(url)

test('官方链接推出官方中继地址', () => {
  const endpoint = endpointOf('https://zcode.z.ai/remote/v4?sid=s&hash=h')
  assert.equal(relayWsUrl(endpoint), 'wss://zcode.z.ai/ws')
})

test('自建中继的域名与端口都保留', () => {
  const endpoint = endpointOf('https://relay.example.com:8443/remote/v4?sid=s&hash=h')
  assert.equal(relayWsUrl(endpoint), 'wss://relay.example.com:8443/ws')
})

test('http 链接推出 ws 而不是 wss', () => {
  const endpoint = endpointOf('http://192.168.1.9:8080/remote/v4?sid=s&hash=h')
  assert.equal(relayWsUrl(endpoint), 'ws://192.168.1.9:8080/ws')
})

test('端点信息缺失时退回官方地址，不抛异常', () => {
  assert.equal(relayWsUrl(null), 'wss://zcode.z.ai/ws')
  assert.equal(relayWsUrl({}), 'wss://zcode.z.ai/ws')
  assert.equal(relayWsUrl({ baseUrl: '这不是链接' }), 'wss://zcode.z.ai/ws')
})
