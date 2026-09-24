/**
 * ZCode 桥接内层 RPC 的线级实现。
 *
 * 结构（逐行对照 OSS 的 `packages/rpc/src/{protocol,serialization,channelClient}.ts`）：
 *
 *   [13 字节帧头] + channel 载荷
 *   帧头 = type:u8 | id:u32BE | ack:u32BE | length:u32BE
 *   载荷 = serialize([RequestType, id, channelName, method]) + serialize(arg)
 *   每个值 = [1 字节 DataType][按需的 VQL 长度][数据]
 *
 * 两个容易踩的点：
 *   - 帧头长度字段是 payload 长度，不含帧头；收帧前必须先确认整帧到齐再消费帧头，
 *     否则粘包场景下会丢掉下一帧的长度信息，请求永远等不到回应；
 *   - 握手不是客户端发起的：服务端先推一个 ResponseType.Initialize(200)，
 *     客户端在此之前发出的请求都要排队。
 */

export const HEADER_SIZE = 13

export const ProtocolMessageType = {
  None: 0,
  Regular: 1,
  Control: 2,
  Ack: 3,
  Disconnect: 5,
  ReplayRequest: 6,
  Pause: 7,
  Resume: 8,
  KeepAlive: 9,
}

export const RequestType = {
  Promise: 100,
  PromiseCancel: 101,
  EventListen: 102,
  EventDispose: 103,
}

export const ResponseType = {
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
}

export const DataType = {
  Undefined: 0,
  String: 1,
  Buffer: 2,
  VSBuffer: 3,
  Array: 4,
  Object: 5,
  Int: 6,
}

// ---------------------------------------------------------------------------
// VQL
// ---------------------------------------------------------------------------

/** VQL 编码：7 位一组，最高位表示"还有后续"。0 → [0x00]，128 → [0x80,0x01]。 */
export function writeVQL(bytes, value) {
  if (value === 0) {
    bytes.push(0)
    return
  }
  let v = value >>> 0
  while (v !== 0) {
    const byte = v & 0x7f
    v >>>= 7
    bytes.push(v > 0 ? byte | 0x80 : byte)
  }
}

function readVQL(reader) {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = reader.readByte()
    value |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) return value >>> 0
    shift += 7
  }
}

// ---------------------------------------------------------------------------
// 值编解码
// ---------------------------------------------------------------------------

export function serializeValue(bytes, data) {
  if (typeof data === 'undefined') {
    bytes.push(DataType.Undefined)
    return
  }
  if (typeof data === 'string') {
    const encoded = utf8Bytes(data)
    bytes.push(DataType.String)
    writeVQL(bytes, encoded.length)
    pushBytes(bytes, encoded)
    return
  }
  if (data instanceof Uint8Array) {
    bytes.push(DataType.Buffer)
    writeVQL(bytes, data.length)
    pushBytes(bytes, data)
    return
  }
  if (Array.isArray(data)) {
    bytes.push(DataType.Array)
    writeVQL(bytes, data.length)
    for (const item of data) serializeValue(bytes, item)
    return
  }
  if (typeof data === 'number' && (data | 0) === data) {
    bytes.push(DataType.Int)
    writeVQL(bytes, data)
    return
  }
  const json = utf8Bytes(JSON.stringify(data) ?? 'null')
  bytes.push(DataType.Object)
  writeVQL(bytes, json.length)
  pushBytes(bytes, json)
}

export function deserializeValue(reader) {
  const type = reader.readByte()
  switch (type) {
    case DataType.Undefined:
      return undefined
    case DataType.String:
      return utf8Decode(reader.read(readVQL(reader)))
    case DataType.Buffer:
      return reader.read(readVQL(reader))
    case DataType.VSBuffer:
      return reader.read(readVQL(reader))
    case DataType.Array: {
      const length = readVQL(reader)
      const out = []
      for (let i = 0; i < length; i++) out.push(deserializeValue(reader))
      return out
    }
    case DataType.Object:
      return JSON.parse(utf8Decode(reader.read(readVQL(reader))))
    case DataType.Int:
      return readVQL(reader)
    default:
      throw new Error(`未知的 DataType: ${type}`)
  }
}

// ---------------------------------------------------------------------------
// 帧
// ---------------------------------------------------------------------------

export function writeFrame({ type = ProtocolMessageType.Regular, id = 0, ack = 0, data = new Uint8Array(0) }) {
  const out = new Uint8Array(HEADER_SIZE + data.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, type)
  view.setUint32(1, id >>> 0, false)
  view.setUint32(5, ack >>> 0, false)
  view.setUint32(9, data.length, false)
  out.set(data, HEADER_SIZE)
  return out
}

/**
 * 流式拆帧器。TCP 风格的字节流没有消息边界，粘包与半包都会出现，
 * 所以先 peek 13 字节读长度，确认整帧到齐才消费。
 */
export class FrameReader {
  constructor() {
    this.buffer = new Uint8Array(0)
  }

  acceptChunk(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length)
    next.set(this.buffer)
    next.set(chunk, this.buffer.length)
    this.buffer = next
  }

  /** @returns {Array<{type:number,id:number,ack:number,data:Uint8Array}>} */
  readFrames() {
    const frames = []
    for (;;) {
      if (this.buffer.length < HEADER_SIZE) break
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, HEADER_SIZE)
      const type = view.getUint8(0)
      const id = view.getUint32(1, false)
      const ack = view.getUint32(5, false)
      const length = view.getUint32(9, false)
      if (this.buffer.length < HEADER_SIZE + length) break

      const data = this.buffer.slice(HEADER_SIZE, HEADER_SIZE + length)
      this.buffer = this.buffer.slice(HEADER_SIZE + length)
      frames.push({ type, id, ack, data })
    }
    return frames
  }
}

// ---------------------------------------------------------------------------
// channel 消息
// ---------------------------------------------------------------------------

export function encodeRequest({ type, id, channelName, method, arg }) {
  const bytes = []
  serializeValue(bytes, [type, id, channelName, method])
  serializeValue(bytes, arg)
  return new Uint8Array(bytes)
}

export function encodeCancel({ type, id }) {
  const bytes = []
  serializeValue(bytes, [type, id])
  serializeValue(bytes, undefined)
  return new Uint8Array(bytes)
}

export function decodeResponse(payload) {
  const reader = createReader(payload)
  const header = deserializeValue(reader)
  const body = deserializeValue(reader)
  return { type: header[0], id: header[1], data: body }
}

/**
 * 桥接通道客户端。用法与 OSS 的 ChannelClient 一致：
 *
 *   const channel = client.getChannel('zcode-agent')
 *   const rows = await channel.call('v4/conversation/rowsRange', { ... })
 *
 * `send` 由调用方注入（把编码后的字节按外层信封发给中继），
 * 这样这套状态机就能脱离传输层被单测覆盖。
 */
export class ChannelClient {
  constructor(send) {
    this.send = send
    this.state = 'uninitialized'
    this.lastRequestId = 0
    this.handlers = new Map()
    this.pending = []
  }

  get ready() {
    return this.state === 'idle'
  }

  /** 服务端推来 Initialize 之后才允许发请求。 */
  markInitialized() {
    if (this.state === 'idle') return
    this.state = 'idle'
    const queued = this.pending.slice()
    this.pending = []
    for (const run of queued) run()
  }

  getChannel(channelName) {
    return {
      call: (method, arg) => this.request(channelName, method, arg),
      listen: (event, arg) => this.listen(channelName, event, arg),
    }
  }

  request(channelName, method, arg, { timeoutMs = 10000 } = {}) {
    const id = this.lastRequestId++
    return new Promise((resolve, reject) => {
      // 超时是必需的，不是锦上添花：通道名或方法名猜错时，桌面端可能**根本不回**，
      // 没有超时的话 promise 永不 settle，界面就停在空白上，用户只能看到"读不到内容"，
      // 拿不到任何可排错的线索。
      const timer = setTimeout(() => {
        if (this.handlers.delete(id)) {
          reject(new Error(`RPC 无响应（${channelName} / ${method}）——通道名或方法名可能不对`))
        }
      }, timeoutMs)

      const doRequest = () => {
        this.handlers.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        this.send(encodeRequest({ type: RequestType.Promise, id, channelName, method, arg }))
      }
      if (this.ready) doRequest()
      else this.pending.push(doRequest)
    })
  }

  listen(channelName, event, arg, onEvent) {
    const id = this.lastRequestId++
    const doRequest = () => {
      this.handlers.set(id, { resolve: onEvent, reject: () => {} })
      this.send(encodeRequest({ type: RequestType.EventListen, id, channelName, method: event, arg }))
    }
    if (this.ready) doRequest()
    else this.pending.push(doRequest)
    return () => {
      this.handlers.delete(id)
      this.send(encodeCancel({ type: RequestType.EventDispose, id }))
    }
  }

  /** 处理一条已解出的响应。 */
  handleResponse({ type, id, data }) {
    if (type === ResponseType.Initialize) {
      this.markInitialized()
      return
    }
    const handler = this.handlers.get(id)
    if (!handler) return
    switch (type) {
      case ResponseType.PromiseSuccess:
        this.handlers.delete(id)
        handler.resolve(data)
        break
      case ResponseType.EventFire:
        handler.resolve(data)
        break
      case ResponseType.PromiseError: {
        this.handlers.delete(id)
        const error = new Error(data?.message ?? 'RPC 调用失败')
        if (data?.name) error.name = data.name
        if (data?.code) error.code = data.code
        handler.reject(error)
        break
      }
      case ResponseType.PromiseErrorObj:
        this.handlers.delete(id)
        handler.reject(data)
        break
      default:
        break
    }
  }

  /** 连接终结：所有在途请求都必须失败，否则界面会永久停在加载态。 */
  dispose(reason = '连接已关闭') {
    this.state = 'disposed'
    const error = new Error(reason)
    for (const [, handler] of this.handlers) handler.reject?.(error)
    this.handlers.clear()
    this.pending = []
  }
}

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

export function pushBytes(target, source) {
  for (let i = 0; i < source.length; i++) target.push(source[i])
}

export function utf8Bytes(text) {
  const str = String(text)
  const out = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

export function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i++]
    if (byte < 0x80) {
      out += String.fromCharCode(byte)
    } else if (byte < 0xe0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i++] & 0x3f))
    } else if (byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      )
    } else {
      const code =
        ((byte & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
      const v = code - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
  }
  return out
}

export function createReader(bytes) {
  let pos = 0
  return {
    readByte() {
      if (pos >= bytes.length) throw new Error('读取越界')
      return bytes[pos++]
    },
    read(count) {
      const slice = bytes.subarray(pos, pos + count)
      pos += slice.length
      return slice
    },
    get offset() {
      return pos
    },
  }
}
