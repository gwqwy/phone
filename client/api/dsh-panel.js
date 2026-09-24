/**
 * dsh 面板：把 dsh 的界面装进 App。
 *
 * 与 ZCode 端点不同，dsh 端点不做协议对接——dsh-pocket 已经把"手机能访问电脑上的 dsh"
 * 这件事解决了，我们只需要把那个地址显示出来。所以这里用 plus.webview 管理多个
 * WebView 实例：**每个端点一个，创建后常驻，切换只做显示/隐藏**，
 * 这样"切过去不用重连、也不用重新等首屏"（dsh 首屏要 20–30 秒）。
 *
 * 小程序端没有 plus，`<web-view>` 也不支持多实例常驻，所以这条路径只在 App 端可用；
 * 小程序版会退化为单面板。
 */

import { buildDshUrl } from '../core/dsh-link.js'

const panels = new Map()

function canUsePlus() {
  return typeof plus !== 'undefined' && typeof plus.webview?.create === 'function'
}

export function isSupported() {
  return canUsePlus()
}

/**
 * 取得（必要时创建）某个端点的面板。
 *
 * @param {object} endpoint dsh 端点
 * @param {object} handlers { onLoaded, onFailed }
 */
export function ensurePanel(endpoint, handlers = {}) {
  if (!canUsePlus()) return null
  const existing = panels.get(endpoint.id)
  if (existing) return existing

  const url = buildDshUrl(endpoint, { withPin: Boolean(endpoint.pin) })
  const panel = plus.webview.create(url, `shou-dsh-${endpoint.id}`, {
    scalable: false,
    softinputMode: 'adjustResize',
    titleNView: { autoBackButton: false },
    // 局域网与隧道地址都可能是明文 http，Android 需要显式放行。
    additionalHttpHeaders: {},
    kernel: 'WKWebview',
  })

  panel.addEventListener('loaded', () => handlers.onLoaded?.(), false)
  panel.addEventListener('error', () => handlers.onFailed?.({ reason: 'load' }), false)
  panel.hide()

  panels.set(endpoint.id, panel)
  return panel
}

/** 显示某个端点的面板并隐藏其他的。 */
export function showPanel(endpoint, handlers = {}) {
  const panel = ensurePanel(endpoint, handlers)
  if (!panel) return null
  for (const [id, other] of panels) {
    if (id !== endpoint.id) {
      try {
        other.hide()
      } catch {
        /* 已被系统回收 */
      }
    }
  }
  try {
    panel.show('none', 0)
  } catch {
    /* 忽略 */
  }
  return panel
}

export function hideAll() {
  for (const [, panel] of panels) {
    try {
      panel.hide()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 重载。地址变了（换了链接/密码）或首屏卡住时用。
 */
export function reloadPanel(endpoint, handlers = {}) {
  const panel = panels.get(endpoint.id)
  const url = buildDshUrl(endpoint, { withPin: Boolean(endpoint.pin) })
  if (!panel) return ensurePanel(endpoint, handlers)
  try {
    panel.loadURL(url)
  } catch {
    closePanel(endpoint.id)
    return ensurePanel(endpoint, handlers)
  }
  return panel
}

export function closePanel(endpointId) {
  const panel = panels.get(endpointId)
  if (!panel) return
  try {
    panel.close()
  } catch {
    /* 忽略 */
  }
  panels.delete(endpointId)
}

export function closeAll() {
  for (const id of [...panels.keys()]) closePanel(id)
}

/** 面板是否已经创建（页面据此决定显示"正在打开"还是真实内容）。 */
export function hasPanel(endpointId) {
  return panels.has(endpointId)
}
