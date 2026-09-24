import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ChannelClient,
  FrameReader,
  HEADER_SIZE,
  ProtocolMessageType,
  RequestType,
  ResponseType,
  createReader,
  decodeResponse,
  deserializeValue,
  encodeRequest,
  serializeValue,
  utf8Bytes,
  utf8Decode,
  writeFrame,
  writeVQL,
} from '../client/core/rpc-wire.js'

function encode(...values) {
  const bytes = []
  for (const value of values) serializeValue(bytes, value)
  return new Uint8Array(bytes)
}

function decodeAll(bytes) {
  const reader = createReader(bytes)
  const out = []
  while (reader.offset < bytes.length) out.push(deserializeValue(reader))
  return out
}

test('VQL 编码：0 占一个字节，128 才需要两个', () => {
  assert.deepEqual([...vql(0)], [0x00])
  assert.deepEqual([...vql(127)], [0x7f])
  assert.deepEqual([...vql(128)], [0x80, 0x01])
  assert.deepEqual([...vql(300)], [0xac, 0x02])
})

function vql(value) {
  const bytes = []
  writeVQL(bytes, value)
  return new Uint8Array(bytes)
}

test('值往返：字符串 / 数组 / 整数 / 对象 / undefined', () => {
  const values = [
    'hello',
    '',
    '中文与 emoji 🚀',
    [1, 'two', [3]],
    [RequestType.Promise, 7, 'zcode-agent', 'v4/command'],
    0,
    42,
    100000,
    { a: 1, b: 'x', c: [true, null] },
    undefined,
  ]
  const decoded = decodeAll(encode(...values))
  assert.equal(decoded.length, values.length)
  for (let i = 0; i < values.length; i++) {
    assert.deepEqual(decoded[i], values[i], `第 ${i} 个值往返不一致`)
  }
})

test('整数用紧凑的 Int 类型，而不是 JSON', () => {
  const bytes = encode(2048)
  assert.equal(bytes[0], 6, 'DataType.Int = 6')
  assert.equal(bytes.length, 3, '类型 1 字节 + VQL 2 字节')
})

test('Uint8Array 往返保持二进制', () => {
  const payload = new Uint8Array([1, 2, 3, 250])
  const [decoded] = decodeAll(encode(payload))
  assert.deepEqual([...decoded], [1, 2, 3, 250])
})

test('帧头 13 字节，字段为大端', () => {
  const frame = writeFrame({ type: ProtocolMessageType.Regular, id: 0x01020304, ack: 0x0a0b0c0d, data: new Uint8Array([9]) })
  assert.equal(frame.length, HEADER_SIZE + 1)
  const view = new DataView(frame.buffer)
  assert.equal(view.getUint8(0), ProtocolMessageType.Regular)
  assert.equal(view.getUint32(1, false), 0x01020304)
  assert.equal(view.getUint32(5, false), 0x0a0b0c0d)
  assert.equal(view.getUint32(9, false), 1)
  assert.equal(frame[13], 9)
})

test('拆帧器处理半包：body 没到齐前不消费帧头', () => {
  const reader = new FrameReader()
  const frame = writeFrame({ type: 1, id: 5, ack: 0, data: utf8Bytes('hello') })
  reader.acceptChunk(frame.subarray(0, HEADER_SIZE + 2))
  assert.deepEqual(reader.readFrames(), [], '半包不能产出帧')
  reader.acceptChunk(frame.subarray(HEADER_SIZE + 2))
  const frames = reader.readFrames()
  assert.equal(frames.length, 1)
  assert.equal(utf8Decode(frames[0].data), 'hello')
  assert.equal(frames[0].id, 5)
})

test('拆帧器处理粘包：一次收到多帧', () => {
  const reader = new FrameReader()
  const a = writeFrame({ type: 1, id: 1, data: utf8Bytes('a') })
  const b = writeFrame({ type: 1, id: 2, data: utf8Bytes('b') })
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  reader.acceptChunk(joined)
  assert.deepEqual(reader.readFrames().map((f) => utf8Decode(f.data)), ['a', 'b'])
})

test('channel 请求编码：头部是四元数组，随后是参数', () => {
  const bytes = encodeRequest({
    type: RequestType.Promise,
    id: 3,
    channelName: 'zcode-agent',
    method: 'v4/conversation/rowsRange',
    arg: { sessionId: 's1' },
  })
  const [header, arg] = decodeAll(bytes)
  assert.deepEqual(header, [RequestType.Promise, 3, 'zcode-agent', 'v4/conversation/rowsRange'])
  assert.deepEqual(arg, { sessionId: 's1' })
})

test('响应解码', () => {
  const payload = encode([ResponseType.PromiseSuccess, 7], { rows: [1, 2] })
  const decoded = decodeResponse(payload)
  assert.equal(decoded.type, ResponseType.PromiseSuccess)
  assert.equal(decoded.id, 7)
  assert.deepEqual(decoded.data, { rows: [1, 2] })
})

test('通道客户端：Initialize 之前排队，之后逐条发出', async () => {
  const sent = []
  const client = new ChannelClient((payload) => sent.push(decodeResponse(payload).type))
  const pending = client.request('zcode-agent', 'v4/controller/subscribe', { a: 1 })
  assert.equal(client.ready, false)
  assert.deepEqual(sent, [], '握手完成前不能发请求')

  client.handleResponse({ type: ResponseType.Initialize })
  assert.equal(client.ready, true)
  assert.deepEqual(sent, [RequestType.Promise], '握手完成后排队的请求才真正发出')

  client.handleResponse({ type: ResponseType.PromiseSuccess, id: 0, data: { ok: true } })
  assert.deepEqual(await pending, { ok: true })
})

test('通道客户端：PromiseError 变成带 code 的异常', async () => {
  const client = new ChannelClient(() => {})
  client.markInitialized()
  const pending = client.request('c', 'm', {})
  client.handleResponse({
    type: ResponseType.PromiseError,
    id: 0,
    data: { message: 'boom', name: 'Fault', code: 'EPERM' },
  })
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, 'boom')
    assert.equal(error.code, 'EPERM')
    return true
  })
})

test('通道客户端：对面不回话时必须超时失败，不能永远挂着', async () => {
  const client = new ChannelClient(() => {})
  client.markInitialized()
  // 通道名或方法名猜错时桌面端可能根本不回——没有超时的话界面就停在空白上，
  // 用户只能看到"读不到内容"，拿不到任何可排错的线索。
  await assert.rejects(client.request('zcode-agent', 'v4/nope', {}, { timeoutMs: 30 }), /无响应/)
})

test('通道客户端：dispose 会让在途请求失败，界面不会永久停在加载态', async () => {
  const client = new ChannelClient(() => {})
  client.markInitialized()
  const pending = client.request('c', 'm', {})
  client.dispose('连接已关闭')
  await assert.rejects(pending, /连接已关闭/)
})

test('通道客户端：listen 收到 EventFire 时回调，取消时发送 EventDispose', () => {
  const sent = []
  const client = new ChannelClient((payload) => sent.push(decodeResponse(payload).type))
  client.markInitialized()
  const seen = []
  const off = client.listen('c', 'v4/conversation/frame', {}, (data) => seen.push(data))
  assert.deepEqual(sent, [RequestType.EventListen])
  client.handleResponse({ type: ResponseType.EventFire, id: 0, data: { delta: 1 } })
  assert.deepEqual(seen, [{ delta: 1 }])
  off()
  assert.deepEqual(sent, [RequestType.EventListen, RequestType.EventDispose])
})
