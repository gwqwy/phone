/**
 * 全局状态与持久化。
 *
 * 两类数据分开放：
 *   - 端点清单（用户资产）走 `EndpointStore`，规则重、有单测；
 *   - 运行时状态（连接灯、会话列表、待办计数）只在内存里，冷启动重建，
 *     不写盘——把运行态持久化只会带来"上次看到的状态"这类假象。
 */

import { computed, reactive } from 'vue'
import { createStorage } from '../core/storage.js'
import { createEndpointStore } from '../core/endpoint-store.js'
import { translate } from '../core/i18n.js'
import { base64, sha256, utf8 } from '../core/crypto.js'
import { DEFAULT_NOTIFY_PREFS, StateDiffer, shouldNotify } from '../core/event-differ.js'
import { SessionIndex, groupByDay, sortSessions } from '../core/session-index.js'
import { LED_LOADING } from '../core/relay-led.js'

const storage = createStorage()
export const endpoints = createEndpointStore(storage)

const KEY_THEME = 'shou.theme'
const KEY_LANG = 'shou.lang'
const KEY_NOTIFY = 'shou.notify'
const KEY_LOCK = 'shou.lock'
const KEY_KEEPALIVE = 'shou.keepalive'
const KEY_WRITE = 'shou.writeEnabled'

export const state = reactive({
  ready: false,
  list: [],
  currentId: '',
  themeMode: 'dark',
  langMode: 'system',
  lang: 'zh',
  notify: { ...DEFAULT_NOTIFY_PREFS },
  lock: { enabled: false, salt: '', hash: '' },
  keepAlive: true,
  /**
   * 实验性写入开关。远程发送/审批依赖中继的桥接 RPC，其方法名与参数形状已按 OSS 还原、
   * 但尚未在真机跑通；默认关闭，避免把"点了没反应"的按钮摆到用户面前。
   */
  writeEnabled: false,
  // 运行时：按端点 id 索引
  led: {},
  tasks: {},
  sessions: {},
  groups: {},
  pending: {},
  // 应用锁
  unlocked: false,
  lockPromptVisible: false,
})

/** 会话索引器与通知差分器不进响应式系统：它们是命令式状态机，包一层只会拖慢更新。 */
const indices = new Map()
const differs = new Map()

export function indexOf(id) {
  if (!indices.has(id)) indices.set(id, new SessionIndex())
  return indices.get(id)
}

export function differOf(id) {
  if (!differs.has(id)) differs.set(id, new StateDiffer())
  return differs.get(id)
}

export function loadSettings() {
  const theme = storage.get(KEY_THEME)
  if (theme === 'dark' || theme === 'light' || theme === 'system') state.themeMode = theme
  const lang = storage.get(KEY_LANG)
  if (lang === 'system' || lang === 'zh' || lang === 'en') state.langMode = lang
  const notify = storage.get(KEY_NOTIFY)
  if (notify && typeof notify === 'object') state.notify = { ...DEFAULT_NOTIFY_PREFS, ...notify }
  const lock = storage.get(KEY_LOCK)
  if (lock && typeof lock === 'object') state.lock = { enabled: false, salt: '', hash: '', ...lock }
  const keepAlive = storage.get(KEY_KEEPALIVE)
  if (typeof keepAlive === 'boolean') state.keepAlive = keepAlive
  state.writeEnabled = storage.get(KEY_WRITE) === true

  applyResolvedLang()
}

function applyResolvedLang() {
  if (state.langMode === 'system') {
    let systemLang = 'zh'
    try {
      systemLang = (uni.getLocale?.() ?? uni.getSystemInfoSync?.().language ?? 'zh').startsWith('en')
        ? 'en'
        : 'zh'
    } catch {
      systemLang = 'zh'
    }
    state.lang = systemLang
  } else {
    state.lang = state.langMode
  }
}

export function setThemeMode(mode) {
  state.themeMode = mode
  storage.set(KEY_THEME, mode)
  applyNativeChrome()
}

export function setLangMode(mode) {
  state.langMode = mode
  storage.set(KEY_LANG, mode)
  applyResolvedLang()
}

export function setNotify(key, value) {
  state.notify = { ...state.notify, [key]: Boolean(value) }
  storage.set(KEY_NOTIFY, state.notify)
}

export function setKeepAlive(value) {
  state.keepAlive = Boolean(value)
  storage.set(KEY_KEEPALIVE, state.keepAlive)
}

export function setWriteEnabled(value) {
  state.writeEnabled = Boolean(value)
  storage.set(KEY_WRITE, state.writeEnabled)
}

/** 主题与语言对原生导航栏的影响要显式设置，CSS 变量管不到原生栏。 */
export function applyNativeChrome() {
  const dark = resolvedTheme() === 'dark'
  try {
    uni.setNavigationBarColor?.({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#0B1016' : '#F4F6F9',
    })
    uni.setBackgroundColor?.({ backgroundColor: dark ? '#0B1016' : '#F4F6F9' })
  } catch {
    /* H5 等平台没有原生栏 */
  }
}

export function resolvedTheme() {
  if (state.themeMode !== 'system') return state.themeMode
  let dark = true
  try {
    dark = uni.getSystemInfoSync?.().theme !== 'light'
  } catch {
    dark = true
  }
  return dark ? 'dark' : 'light'
}

export const themeClass = computed(() => (resolvedTheme() === 'dark' ? 'theme-dark' : 'theme-light'))

export function t(key, arg) {
  return translate(state.lang, key, arg)
}

export function refreshList() {
  state.list = endpoints.list()
  if (!state.currentId && state.list.length) state.currentId = state.list[0].id
  return state.list
}

export function initApp() {
  if (state.ready) return
  loadSettings()
  refreshList()
  state.ready = true
  applyNativeChrome()
}

export function currentEndpoint() {
  return endpoints.get(state.currentId)
}

export function importEndpoint(input) {
  const result = endpoints.import(input)
  refreshList()
  if (result.status === 'added' || result.status === 'duplicate') {
    const id = result.endpoint?.id ?? result.existing?.id
    if (id) selectEndpoint(id)
  }
  return result
}

export function selectEndpoint(id) {
  state.currentId = id
  endpoints.touchLast(id)
}

export function removeEndpoint(id) {
  endpoints.remove(id)
  indices.delete(id)
  differs.delete(id)
  delete state.led[id]
  delete state.tasks[id]
  delete state.sessions[id]
  delete state.groups[id]
  delete state.pending[id]
  if (state.currentId === id) state.currentId = ''
  refreshList()
}

export function renameEndpoint(id, label) {
  endpoints.rename(id, label)
  refreshList()
}

export function replaceEndpointLink(id, input) {
  const next = endpoints.replaceLink(id, input)
  refreshList()
  return next
}

/** 用会话索引重建某个端点的任务列表、分组与待办计数。 */
export function recompute(id) {
  const index = indexOf(id)
  const all = index.list()
  state.tasks[id] = all
  state.sessions[id] = all
  state.groups[id] = groupByDay(all, { lang: state.lang })
  const pending = {}
  for (const item of all) {
    pending[item.sessionId] = {
      permissionCount: item.permissionCount,
      userInputCount: item.userInputCount,
      toolName: item.toolName,
      description: item.description,
    }
  }
  state.pending[id] = pending
}

export function setLed(id, led) {
  state.led[id] = led ?? LED_LOADING
}

export function ledOf(id) {
  return state.led[id] ?? LED_LOADING
}

/** 通知决策集中在这里，页面只负责把它交给系统通知。 */
export function eventsForNotify(id, states) {
  const differ = differOf(id)
  const events = differ.apply(states)
  return events.filter((event) => shouldNotify(event.type, state.notify))
}

// ---------------------------------------------------------------------------
// 应用锁
// ---------------------------------------------------------------------------

/**
 * 口令只存加盐摘要。
 *
 * 说清楚它的边界：这是**界面锁**，不是加密——Android/iOS 的本地存储对 root/越狱设备
 * 可读，所以它挡的是"拿到你手机的人随手翻开 App"，不是"拿到你手机并会取证的人"。
 * 指纹/面容识别需要原生插件（uni 无官方 API），留给后续版本。
 */
export function setPasscode(passcode) {
  const salt = randomSalt()
  state.lock = { enabled: true, salt, hash: hashPasscode(passcode, salt) }
  storage.set(KEY_LOCK, state.lock)
}

export function clearPasscode() {
  state.lock = { enabled: false, salt: '', hash: '' }
  storage.set(KEY_LOCK, state.lock)
}

export function verifyPasscode(passcode) {
  if (!state.lock.enabled) return true
  return hashPasscode(passcode, state.lock.salt) === state.lock.hash
}

export function lockEnabled() {
  return Boolean(state.lock.enabled)
}

function hashPasscode(passcode, salt) {
  return base64(sha256(utf8(`shou|${salt}|${passcode}`)), true)
}

function randomSalt() {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return base64(bytes, true)
}

/** 让界面上的任务列表保持排序一致（供页面在局部更新后调用）。 */
export function sortedTasks(id) {
  return sortSessions(state.tasks[id] ?? [])
}
