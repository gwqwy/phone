import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelaySession } from '../client/api/relay-client.js'
import { parsePairingLink } from '../client/core/pairing-link.js'
import { ProtocolMessageType, ResponseType, serializeValue, writeFrame } from '../client/core/rpc-wire.js'

/**
 * 握手与时序的回归测试。
 *
 * 用假 socket 跑完整流程，把"应该按什么顺序发哪些信封"钉死。真机上这类问题
 * 表现为"连上了但看不到内容"，而日志里一眼就能看出少发了哪一步——所以顺序值得用测试守住。
 */

function fakeSocket() {
  const sent = []
  const handlers = {}
  return {
    sent,
    send: (text) => sent.push(JSON.parse(text)),
    close: () => handlers.close?.({ code: 1000, reason: '' }),
    onOpen: (fn) => (handlers.open = fn),
    onMessage: (fn) => (handlers.message = fn),
    onError: (fn) => (handlers.error = fn),
    onClose: (fn) => (handlers.close = fn),
    open: () => handlers.open?.({}),
    deliver: (obj) => handlers.message?.(JSON.stringify(obj)),
  }
}

function makeSession() {
  const socket = fakeSocket()
  const endpoint = parsePairingLink('https://zcode.z.ai/remote/v4?sid=sid123&hash=passhash&app_version=3.14.3', {
    id: 'e1',
  })
  const session = new RelaySession({ endpoint, connect: () => socket })
  return { socket, session }
}

const kinds = (socket) => socket.sent.map((message) => message.payload?.zcode_type ?? message.type)

test('认证握手：auth_init → auth_response，参数形态正确', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  assert.equal(socket.sent[0].type, 'auth_init')
  assert.equal(socket.sent[0].role, 'terminal')
  assert.equal(socket.sent[0].device_sid, 'sid123')
  assert.equal(socket.sent[0].meta.version, '3.14.3', 'meta.version 取配对链接里的 app_version')

  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  assert.equal(socket.sent[1].type, 'auth_response')
  assert.equal(socket.sent[1].device_sid, 'sid123')
  assert.ok(socket.sent[1].proof, 'proof 必须带上')
})

test('matched 之后依次发 bootstrap 与 workspace-list', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })
  assert.deepEqual(kinds(socket).slice(2), ['bootstrap-request'])

  socket.deliver({ type: 'data', payload: { zcode_type: 'bootstrap-response', requestId: 'bootstrap-1', result: {} } })
  assert.deepEqual(kinds(socket).slice(3), ['workspace-list-request'])
})

test('waiting 时不发 bootstrap（发了也没人执行）', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'waiting' })
  assert.equal(session.state, 'waiting')
  assert.deepEqual(kinds(socket), ['auth_init', 'auth_response'], '不该发任何数据面请求')
})

test('打开桥接：直接发 bridge-open，不发明知会被拒的 workspace-reconnect', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })

  const bridge = session.openWorkspaceBridge('W:\\ws\\demo', 'sess_1')
  assert.ok(bridge.bridgeSessionId, '桥接身份由客户端生成')

  const last = () => socket.sent[socket.sent.length - 1]
  assert.equal(last().payload.zcode_type, 'workspace-bridge-open')
  assert.equal(last().payload.workspaceKey, 'W:\\ws\\demo', '必须是完整键，不是 basename')
  assert.equal(last().payload.taskId, 'sess_1')
  assert.equal(
    socket.sent.some((message) => message.payload?.zcode_type === 'workspace-reconnect-request'),
    false,
    'workspace-reconnect 是给 ssh/wsl/docker 远程工作区用的，拿本地路径发它只会被拒',
  )
  session.stop()
})

test('同一个工作区重复调用只发一次 bridge-open', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })

  session.openWorkspaceBridge('W:\\ws\\demo', 'sess_1')
  session.openWorkspaceBridge('W:\\ws\\demo', 'sess_1')
  assert.equal(
    socket.sent.filter((message) => message.payload?.zcode_type === 'workspace-bridge-open').length,
    1,
    '任务列表页与会话页各调一次，真机日志里曾出现同一毫秒两发',
  )
  session.stop()
})

test('bridge-ready 之后通道就绪，并发出 clientHello 与订阅', async () => {
  const { socket, session } = makeSession()
  const ready = []
  session.handlers.onBridgeReady = (bridge, channel) => ready.push({ bridge, channel })
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })
  session.openWorkspaceBridge('W:\\ws\\demo', 'sess_1')

  socket.deliver({
    type: 'data',
    payload: {
      zcode_type: 'workspace-bridge-ready',
      bridge: {
        bridgeSessionId: 'b1',
        bridgeGeneration: 0,
        recoveryId: 'r1',
        workspaceKey: 'W:\\ws\\demo',
        initialTaskId: 'sess_1',
      },
    },
  })
  assert.equal(ready.length, 1)
  assert.equal(session.channel !== null, true, '通道必须就绪，否则会话内容永远读不到')

  const hello = socket.sent.find((message) => message.payload?.kind === 'clientHello')
  assert.ok(hello, 'bridge-ready 之后要自报家门，host 依赖它注入 clientMode')
  assert.equal(hello.payload.clientKind, 'mobileRemote')
  session.stop()
})

test('桥接身份是 UUID v4 形态（自定义字符串有被桌面端校验拒掉的风险）', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  const bridge = session.openWorkspaceBridge('W:\\ws\\demo')
  assert.match(bridge.bridgeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(bridge.recoveryId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  session.stop()
})

test('诊断日志记录收发两个方向', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  const directions = session.log.map((entry) => entry.direction)
  assert.ok(directions.includes('→'))
  assert.ok(directions.includes('←'))
  assert.ok(session.log.some((entry) => entry.text.includes('auth_challenge')), '入站原文要留下来')
  session.stop()
})

test('桥接帧的日志只记长度摘要，不把二进制整段打进日志', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  session.sendRpcFrame(new Uint8Array([1, 2, 3]))
  const outbound = session.log.filter((entry) => entry.direction === '→').pop()
  assert.match(outbound.text, /dataBase64/)
  assert.ok(outbound.text.length < 600, '日志不该被二进制撑爆')
  session.stop()
})

test('收到 rpc 响应帧时解出 channel 响应', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  const seen = []
  session.channel.handleResponse = (decoded) => seen.push(decoded)

  // 用模块自己的编码器拼帧，而不是手写字节：channel 载荷是 serialize(header) + serialize(body)，
  // 外面再套 13 字节帧头，少一层就会被解成读取越界。
  const payload = []
  serializeValue(payload, [ResponseType.Initialize])
  serializeValue(payload, undefined)
  const framed = writeFrame({
    type: ProtocolMessageType.Regular,
    id: 0,
    ack: 0,
    data: new Uint8Array(payload),
  })
  session.handleRpcFrame({ dataBase64: Buffer.from(framed).toString('base64') })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, ResponseType.Initialize)
  session.stop()
})

test('keepalive 帧会被回以 ACK（用最后收到的 id，而不是自己的计数）', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  const before = socket.sent.length

  const framed = writeFrame({ type: ProtocolMessageType.KeepAlive, id: 42, ack: 0, data: new Uint8Array(0) })
  session.handleRpcFrame({ dataBase64: Buffer.from(framed).toString('base64') })

  assert.ok(socket.sent.length > before, '必须回 ACK，否则桌面端会判定链路死亡')
  session.stop()
})
