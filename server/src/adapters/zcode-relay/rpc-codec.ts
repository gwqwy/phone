/**
 * ZCode RPC 二进制编码层（relay 阶段二基础设施）
 *
 * 规范来源：OSS `packages/rpc/src/serialization.ts` + `protocol.ts`（已逐行核对）
 *
 * 桥接内层（dataBase64）结构：
 *   [13 字节帧头] + channel 载荷
 *   帧头：{ type:u8(=1 Regular), id:u32BE, ack:u32BE, length:u32BE }
 *   channel 载荷：serialize([RequestType, id, channelName, method]) + serialize(arg)
 *
 * 每个值编码： [1 byte DataType][VQL 长度(按需)][数据]
 *   DataType: Undefined=0, String=1, Buffer=2, VSBuffer=3, Array=4, Object=5(JSON), Int=6(VQL)
 */

/** 数据类型标记（用常量对象而非 enum：Node 的类型剥离模式不支持 enum） */
export const RpcDataType = {
  Undefined: 0,
  String: 1,
  Buffer: 2,
  VSBuffer: 3,
  Array: 4,
  Object: 5,
  Int: 6,
} as const

export const RPC_FRAME_TYPE_REGULAR = 1
export const RPC_FRAME_TYPE_CONTROL = 2
export const RPC_FRAME_TYPE_ACK = 3
export const RPC_FRAME_TYPE_KEEPALIVE = 9
export const RPC_HEADER_SIZE = 13

/** 请求类型（packages/rpc/src/channels.shared.ts） */
export const RpcRequestType = {
  Promise: 100,
  PromiseCancel: 101,
  EventListen: 102,
  EventDispose: 103,
} as const

/** 响应类型（同上） */
export const RpcResponseType = {
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
} as const

/** ZCode 服务通道名（packages/shared/src/channels.ts 的 ServiceChannels） */
export const RPC_CHANNEL_ZCODE_AGENT = 'zcode-agent'

/** VQL 变长整数编码（7 bit 一组，最高位续位） */
export function writeInt32VQL(value: number): Buffer {
  if (value === 0) return Buffer.from([0])
  const bytes: number[] = []
  let v = value >>> 0
  const scratch: number[] = []
  for (let i = 0; v !== 0; i += 1) {
    scratch[i] = v & 0b01111111
    v = v >>> 7
    if (v > 0) scratch[i]! |= 0b10000000
  }
  bytes.push(...scratch)
  return Buffer.from(bytes)
}

export function readInt32VQL(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0
  let n = 0
  let pos = offset
  for (;;) {
    const b = buf[pos] ?? 0
    pos += 1
    value |= (b & 0b01111111) << n
    if ((b & 0b10000000) === 0) break
    n += 7
  }
  return { value: value >>> 0, next: pos }
}

export function serializeValue(value: unknown): Buffer {
  if (value === undefined || value === null) return Buffer.from([RpcDataType.Undefined])
  if (typeof value === 'string') {
    const data = Buffer.from(value, 'utf8')
    return Buffer.concat([Buffer.from([RpcDataType.String]), writeInt32VQL(data.length), data])
  }
  if (typeof value === 'number') {
    return Buffer.concat([Buffer.from([RpcDataType.Int]), writeInt32VQL(Math.trunc(value))])
  }
  if (typeof value === 'boolean') {
    return Buffer.concat([Buffer.from([RpcDataType.Int]), writeInt32VQL(value ? 1 : 0)])
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = Buffer.from(value)
    return Buffer.concat([Buffer.from([RpcDataType.VSBuffer]), writeInt32VQL(data.length), data])
  }
  if (Array.isArray(value)) {
    const parts: Buffer[] = [Buffer.from([RpcDataType.Array]), writeInt32VQL(value.length)]
    for (const item of value) parts.push(serializeValue(item))
    return Buffer.concat(parts)
  }
  const json = Buffer.from(JSON.stringify(value), 'utf8')
  return Buffer.concat([Buffer.from([RpcDataType.Object]), writeInt32VQL(json.length), json])
}

export function deserializeValue(buf: Buffer, offset = 0): { value: unknown; next: number } {
  const type = buf[offset] ?? 0
  let pos = offset + 1
  const readLen = (): number => {
    const r = readInt32VQL(buf, pos)
    pos = r.next
    return r.value
  }
  switch (type) {
    case RpcDataType.Undefined:
      return { value: undefined, next: pos }
    case RpcDataType.String: {
      const len = readLen()
      const value = buf.subarray(pos, pos + len).toString('utf8')
      return { value, next: pos + len }
    }
    case RpcDataType.Int: {
      const r = readInt32VQL(buf, pos)
      return { value: r.value, next: r.next }
    }
    case RpcDataType.Buffer:
    case RpcDataType.VSBuffer: {
      const len = readLen()
      const value = Buffer.from(buf.subarray(pos, pos + len))
      return { value, next: pos + len }
    }
    case RpcDataType.Array: {
      const count = readLen()
      const arr: unknown[] = []
      for (let i = 0; i < count; i += 1) {
        const r = deserializeValue(buf, pos)
        arr.push(r.value)
        pos = r.next
      }
      return { value: arr, next: pos }
    }
    case RpcDataType.Object: {
      const len = readLen()
      const raw = buf.subarray(pos, pos + len).toString('utf8')
      let value: unknown = undefined
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
      return { value, next: pos + len }
    }
    default:
      return { value: undefined, next: pos }
  }
}

/** 13 字节帧封装 */
export function frameRpc(header: Buffer, payload: Buffer, id = 0, ack = 0): Buffer {
  const frame = Buffer.alloc(RPC_HEADER_SIZE + header.length + payload.length)
  frame.writeUInt8(RPC_FRAME_TYPE_REGULAR, 0)
  frame.writeUInt32BE(id >>> 0, 1)
  frame.writeUInt32BE(ack >>> 0, 5)
  frame.writeUInt32BE(header.length + payload.length, 9)
  header.copy(frame, RPC_HEADER_SIZE)
  payload.copy(frame, RPC_HEADER_SIZE + header.length)
  return frame
}

/**
 * 解出 13 字节帧序列（粘包处理）。
 * 注意：PersistentProtocol 会混发 Regular(1)/控制帧(2)/Ack(3)/KeepAlive(9)，
 * 必须全部解出并按类型分派，否则对端等不到确认会判定 rpc-transport-fault。
 */
export function parseRpcFrames(data: Buffer): { type: number; id: number; ack: number; body: Buffer }[] {
  const out: { type: number; id: number; ack: number; body: Buffer }[] = []
  let off = 0
  while (off + RPC_HEADER_SIZE <= data.length) {
    const type = data.readUInt8(off)
    const id = data.readUInt32BE(off + 1)
    const ack = data.readUInt32BE(off + 5)
    const len = data.readUInt32BE(off + 9)
    if (len > 32 * 1024 * 1024 || off + RPC_HEADER_SIZE + len > data.length) break
    out.push({ type, id, ack, body: Buffer.from(data.subarray(off + RPC_HEADER_SIZE, off + RPC_HEADER_SIZE + len)) })
    off += RPC_HEADER_SIZE + len
  }
  return out
}

/** 构造控制帧（KeepAlive / Ack；无载荷） */
export function frameControl(type: number, id: number, ack: number): Buffer {
  const frame = Buffer.alloc(RPC_HEADER_SIZE)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(id >>> 0, 1)
  frame.writeUInt32BE(ack >>> 0, 5)
  frame.writeUInt32BE(0, 9)
  return frame
}
