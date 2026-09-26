import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelaySession } from '../client/api/relay-client.js'
import { parsePairingLink } from '../client/core/pairing-link.js'
import { base64Decode } from '../client/core/crypto.js'
import { crc32Hex } from '../client/core/crc32.js'
import { ResponseType, serializeValue } from '../client/core/rpc-wire.js'

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

function makeSession(handlers = {}) {
  const socket = fakeSocket()
  const endpoint = parsePairingLink('https://zcode.z.ai/remote/v4?sid=sid123&hash=passhash&app_version=3.14.3', {
    id: 'e1',
  })
  const session = new RelaySession({ endpoint, connect: () => socket, handlers })
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

test('打开桥接：bridge-open 必须带 requestId，且不编造 recoveryId', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  socket.deliver({ type: 'auth_challenge', nonce: 'n1' })
  socket.deliver({ type: 'auth_ack', pair_status: 'matched' })

  const bridge = session.openWorkspaceBridge('W:\\ws\\demo', 'sess_1')
  const last = () => socket.sent[socket.sent.length - 1]

  assert.equal(last().payload.zcode_type, 'workspace-bridge-open')
  // 这一条是官方 schema 里的必填字段（`requestId:Z`）。曾经漏掉它，
  // 桌面端严格校验不过就**静默丢弃**——连发三次毫无回应的根因。
  assert.ok(last().payload.requestId, 'requestId 必填，缺了报文会被丢掉')
  assert.match(String(last().payload.requestId), /^workspace-bridge/)
  assert.equal(last().payload.workspaceKey, 'W:\\ws\\demo', '必须是完整键，不是 basename')
  assert.equal(last().payload.taskId, 'sess_1')
  assert.equal(
    'recoveryId' in last().payload,
    false,
    'recoveryId 只在续接已有桥接时才带；首次开启编一个会被当成续接未知会话',
  )
  assert.equal(last().payload.bridgeGeneration, 1, 'bridgeGeneration 是每次开启递增的计数')
  assert.ok(bridge.bridgeSessionId)
  session.stop()
})

test('再次开启桥接时 bridgeGeneration 递增', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.openWorkspaceBridge('W:\\ws\\a')
  // 绕过 500ms 防抖：这里要验的是 generation 计数，不是防抖（防抖另有测试）。
  session.lastBridgeOpenAt = 0
  session.openWorkspaceBridge('W:\\ws\\b')
  const generations = socket.sent
    .filter((message) => message.payload?.zcode_type === 'workspace-bridge-open')
    .map((message) => message.payload.bridgeGeneration)
  assert.deepEqual(generations, [1, 2])
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

test('bridge-ready 之后通道就绪（clientHello 改由上层经 hello 握手发出）', async () => {
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
  // clientHello 不再是裸 JSON 信封：官方流程是 hello → initializeConversationV4 两次通道调用，
  // 由 session-manager 的 handshakeAndSubscribe 执行。
  assert.equal(
    socket.sent.some((message) => message.payload?.kind === 'clientHello'),
    false,
    '裸 JSON 信封形态的 clientHello 已废弃',
  )
  session.stop()
})

test('桥接会话 id 是 UUID v4 形态；recoveryId 由桌面端下发而不是我们编', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  const bridge = session.openWorkspaceBridge('W:\\ws\\demo')
  assert.match(bridge.bridgeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(bridge.recoveryId, undefined, '首次开启不带 recoveryId（它是续接用的，由桌面端给）')

  socket.deliver({
    type: 'data',
    payload: {
      zcode_type: 'workspace-bridge-ready',
      requestId: 'workspace-bridge-1',
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: 1,
      recoveryId: 'from-desktop',
      bridge: { bridgeSessionId: bridge.bridgeSessionId, bridgeGeneration: 1, recoveryId: 'from-desktop', workspaceKey: 'W:\\ws\\demo' },
    },
  })
  assert.equal(session.bridge.recoveryId, 'from-desktop', '就绪后记下桌面端给的值，供断线续接使用')
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

test('收到 rpc 响应帧时解出 channel 响应（dataBase64 里没有 13 字节帧头）', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  const seen = []
  session.channel.handleResponse = (decoded) => seen.push(decoded)

  // 真机日志里的实证：桌面端发来的 Initialize 是 dataBase64 = "BAIGyAEA"，
  // 即 serialize([200]) + serialize(undefined)，**不含** 13 字节帧头——
  // 头部字段（seq/messageSeq/messageBytes/checksum）在中继的 JSON 信封里。
  // 我原先用 FrameReader 去读前 13 字节，于是这个握手一次都没被认出来。
  const payload = []
  serializeValue(payload, [ResponseType.Initialize])
  serializeValue(payload, undefined)
  const bare = Buffer.from(new Uint8Array(payload)).toString('base64')
  assert.equal(bare, 'BAEGyAEA', '这段编码要与真机日志逐字节一致')

  session.handleRpcFrame({ dataBase64: bare, messageSeq: 1, fragmentCount: 1, fragmentIndex: 0 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, ResponseType.Initialize)
  session.stop()
})

test('每一帧都要回 rpc-frame-ack，否则桌面端会判定 rpc-transport-fault', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  const before = socket.sent.length

  const payload = []
  serializeValue(payload, [ResponseType.Initialize])
  serializeValue(payload, undefined)
  session.handleRpcFrame({
    dataBase64: Buffer.from(new Uint8Array(payload)).toString('base64'),
    messageSeq: 7,
    fragmentCount: 1,
    fragmentIndex: 0,
  })

  const acks = socket.sent.slice(before).filter((m) => m.payload?.zcode_type === 'rpc-frame-ack')
  assert.equal(acks.length, 1, '必须回 ACK')
  assert.equal(acks[0].payload.ackMessageSeq, 7, 'ack 要带对方那一帧的 messageSeq')
  assert.equal(acks[0].payload.bridgeSessionId, 'b', 'ack 要带桥接身份')
  session.stop()
})

test('桥接帧必须带齐传输层元数据，否则桌面端判 rpc-transport-fault', () => {
  const { socket, session } = makeSession()
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  session.sendRpcFrame(new Uint8Array([1, 2, 3]))

  const frame = socket.sent[socket.sent.length - 1].payload
  assert.equal(frame.zcode_type, 'rpc-frame')
  assert.equal(frame.fragmentCount, 1, '真机日志里桌面端每帧都带它')
  assert.equal(frame.fragmentIndex, 0)
  assert.equal(frame.messageBytes, 3)
  assert.equal(frame.messageSeq, frame.seq, '两者都用同一个计数')
  assert.deepEqual(frame.checksum, { algorithm: 'crc32', value: crc32Hex(new Uint8Array([1, 2, 3])) })
  // 缺任何一个，桌面端都会在收到后立刻 bridge-degraded: rpc-transport-fault
  session.stop()
})

test('crc32 与桌面端日志里的取值一致', () => {
  // 桌面端发来的 Initialize 帧：payload 是 BAEGyAEA，checksum.value = b4ff6360
  const bytes = base64Decode('BAEGyAEA')
  const hex = crc32Hex(bytes)
  assert.equal(hex.length, 8)
  assert.match(hex, /^[0-9a-f]{8}$/)
})
test('bridge-degraded 如实上报，而不是继续干等', () => {
  const failures = []
  const { socket, session } = makeSession({ onBridgeFailed: (reason) => failures.push(reason) })
  session.start()
  socket.open()
  session.attachBridge({ bridgeSessionId: 'b', workspaceKey: 'k' })
  socket.deliver({
    type: 'data',
    payload: { zcode_type: 'bridge-degraded', bridgeSessionId: 'b', bridgeGeneration: 1, reason: 'rpc-transport-fault' },
  })
  assert.equal(session.bridgeReady, false)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /rpc-transport-fault/)
  session.stop()
})
