/**
 * 连接状态灯。
 *
 * 三种状态：连接中（loading）、已连接（live）、异常（error）。
 * 判断依据只有两类，且都必须严格按官方语义解释，否则会出现"明明断了却显示绿的"。
 */

export const LED_LOADING = 'loading'
export const LED_LIVE = 'live'
export const LED_ERROR = 'error'

/**
 * 中继侧宣告会话终结的关闭原因。命中即认为这条连接不会再自愈，必须让用户重新配对；
 * 不命中则只当作一次普通断开，界面继续显示"连接中"并自动重连。
 *
 * 注意 `kicked` **不在**这个列表里：被踢的含义是"另一个客户端占用了同一个 sid"
 * （最常见的是官方远控页面开着），这不是配对失效，把灯变红并提示"重新扫码"会误导用户。
 * 它由下面的 TAKEOVER_CODES 单独处理。
 */
export const TERMINAL_REASONS = [
  'desktop-disconnected',
  'desktop-bootstrap-timeout',
  'connection-recovery-timeout',
  'session-not-found',
  'session-expired',
  'session-conflict',
  'workspace-closed',
  'invalid-mobile-connection',
]

/** 可恢复的错误码：桌面端暂时离线或服务端内部错误，重连即可，不该把灯变红。 */
export const RECOVERABLE_CODES = new Set(['DEVICE_OFFLINE', 'INTERNAL'])

/**
 * 被接管的错误码。同一个 sid 只允许一条移动端连接，官方页面或另一台手机会把我们挤掉。
 * 这既不表示配对失效，也不表示本该连，只是"此刻轮不到我们"——保持"连接中"并稍后重试。
 */
export const TAKEOVER_CODES = new Set(['KICKED'])

/**
 * 数据帧对状态的影响。
 *
 * 官方会主动推状态帧，所以"收到 data 即已连接"是最可靠的在世信号——比 WebSocket 的
 * open 更可靠，因为 open 之后仍可能立刻被踢。
 */
export function onFrameRoot(message) {
  if (!message || typeof message !== 'object') return null
  if (message.type === 'data') return LED_LIVE
  if (message.type === 'error') {
    const code = String(message.code ?? '').toUpperCase()
    if (RECOVERABLE_CODES.has(code) || TAKEOVER_CODES.has(code)) return null
    return LED_ERROR
  }
  return null
}

/** 这个错误是不是"被别的客户端接管了"。 */
export function isTakeoverCode(code) {
  return TAKEOVER_CODES.has(String(code ?? '').toUpperCase())
}

/** WebSocket 生命周期事件对状态的影响。 */
export function onSocketEvent(event) {
  if (!event) return null
  if (event.kind === 'open') return LED_LOADING
  if (event.kind === 'closed') {
    return isTerminalClose(event.code, event.reason) ? LED_ERROR : LED_LOADING
  }
  return null
}

/** 真的需要重新配对：链接失效/过期、或这条移动连接不被承认。 */
export const REPAIR_CLOSE_CODES = new Set([
  4004, // SessionNotFound
  4011, // SessionExpired
  4013, // InvalidMobileConnection
])

/**
 * 被别的客户端接管：**协议里一个设备同时只允许一条移动连接**，
 * 官方远控页面或另一台手机占了它。这**不是**配对失效——让用户去重新扫码是误导，
 * 他真正要做的只是关掉那边。
 */
export const TAKEOVER_CLOSE_CODES = new Set([
  4009, // SessionConflict
])

/** 电脑端那一侧没了（远控页面关掉、工作区关闭）。等它回来即可，不必重新配对。 */
export const DESKTOP_GONE_CLOSE_CODES = new Set([
  4010, // DesktopDisconnected
  4012, // WorkspaceClosed
])

export const CLOSE_REPAIR = 'repair'
export const CLOSE_TAKEOVER = 'takeover'
export const CLOSE_DESKTOP_GONE = 'desktop-gone'
export const CLOSE_TRANSIENT = 'transient'

/**
 * 把一次关闭归到四类之一——这四类的处理方式完全不同，混在一起说就会误报。
 *
 * 判定顺序：先看原因文本（官方会把原因写清楚），再看关闭码。
 * 拿不准的一律归为 transient（自动重连），因为误报"需要重新配对"会逼用户做一件没必要的事。
 */
export function classifyClose(code, reason) {
  const text = String(reason ?? '').toLowerCase()
  if (text.includes('kicked') || text.includes('session-conflict') || text.includes('session_conflict')) {
    return CLOSE_TAKEOVER
  }
  if (text.includes('desktop-disconnected') || text.includes('workspace-closed')) {
    return CLOSE_DESKTOP_GONE
  }
  if (text.includes('session-not-found') || text.includes('session-expired') || text.includes('invalid-mobile-connection')) {
    return CLOSE_REPAIR
  }

  const numeric = Number(code ?? 0)
  if (TAKEOVER_CLOSE_CODES.has(numeric)) return CLOSE_TAKEOVER
  if (DESKTOP_GONE_CLOSE_CODES.has(numeric)) return CLOSE_DESKTOP_GONE
  if (REPAIR_CLOSE_CODES.has(numeric)) return CLOSE_REPAIR
  return CLOSE_TRANSIENT
}

/**
 * 这次关闭是否应该判为终态（需要用户动作）。
 *
 * 只有"真的要重新配对"才算终态。被接管、电脑端离线都只是暂时的，交给自动重连。
 */
export function isTerminalClose(code, reason) {
  return classifyClose(code, reason) === CLOSE_REPAIR
}

/** 关闭原因是否属于终态（界面据此决定是提示"重新扫码"还是静默重连）。 */
export function isTerminalReason(reason) {
  const text = String(reason ?? '')
  return TERMINAL_REASONS.some((token) => text.includes(token))
}

/**
 * 页面加载失败是否算连接异常。
 *
 * 只有主文档、且明确拿到 4xx/5xx 才算；拿不到状态码时按「不算」处理——
 * 宁可少报一次异常，也不要在正常的重定向过程中闪一次红。
 */
export function pageFailureIsConnectionError({ isMainFrame, statusCode }) {
  if (isMainFrame !== true) return false
  return typeof statusCode === 'number' && statusCode >= 400
}
