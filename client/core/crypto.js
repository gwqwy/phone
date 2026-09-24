/**
 * SHA-256 / HMAC-SHA256 / base64url —— 纯 JavaScript 实现。
 *
 * 为什么不直接用 Web Crypto：中继认证的 proof 是 HMAC-SHA256，而小程序的 JS 运行时
 * 没有 `crypto.subtle`，uni 也不提供 HMAC。为了让同一份认证代码在 App 与小程序上
 * 表现一致，这里自己实现，并用标准测试向量在单测里逐条钉死。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

/** @param {Uint8Array} bytes @returns {Uint8Array} 32 字节摘要 */
export function sha256(bytes) {
  const h = H0.slice()
  const len = bytes.length
  const withPad = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  withPad.set(bytes)
  withPad[len] = 0x80
  const bits = len * 8
  const view = new DataView(withPad.buffer)
  // 长度字段 64 位大端；JS 的位运算只有 32 位，高位手动算，避免超长输入时溢出。
  view.setUint32(withPad.length - 8, Math.floor(bits / 0x100000000), false)
  view.setUint32(withPad.length - 4, bits >>> 0, false)

  const w = new Uint32Array(64)
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false)
  return out
}

/** HMAC-SHA256，返回 32 字节。 */
export function hmacSha256(key, message) {
  let k = key instanceof Uint8Array ? key : utf8(String(key))
  if (k.length > 64) k = sha256(k)

  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(96)
  for (let i = 0; i < 64; i++) {
    const byte = i < k.length ? k[i] : 0
    inner[i] = byte ^ 0x36
    outer[i] = byte ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

/** UTF-8 编码。`TextEncoder` 在小程序里同样可能缺席。 */
export function utf8(text) {
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
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
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

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 编码；`urlSafe` 时换成 base64url 且去掉填充（中继的 proof 用这个形态）。 */
export function base64(bytes, urlSafe = false) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f]
  }
  if (!urlSafe) return out
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64 / base64url 解码。 */
export function base64Decode(text) {
  const clean = String(text).replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')).replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let index = 0
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64_ALPHABET.indexOf(clean[i])
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, index)
}
