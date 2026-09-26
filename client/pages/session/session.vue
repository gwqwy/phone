<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-bar">
      <view class="shou-title shou-bar__name">{{ title || sessionId }}</view>
      <view v-if="pending.permissionCount" class="shou-pill shou-pill--error">{{ pending.permissionCount }}</view>
      <view class="shou-chip" @tap="openDiag">{{ t('diag') }}</view>
    </view>
    <view class="shou-sub shou-bar__meta">{{ statusLine }}</view>

    <view v-if="!items.length" class="shou-empty">
      <view class="shou-empty__title">{{ emptyTitle }}</view>
      <view>{{ emptyBody }}</view>
      <view class="shou-empty__row">
        <view v-if="bridge === 'timeout' || lastError" class="shou-btn shou-empty__btn" @tap="retryBridge">
          {{ t('retryBridge') }}
        </view>
        <view class="shou-btn shou-btn--ghost shou-empty__btn" @tap="openDiag">{{ t('diag') }}</view>
      </view>
    </view>

    <view v-for="item in items" :key="item.id" class="shou-card shou-item" :class="`shou-item--${item.kind}`">
      <view v-if="item.title || item.meta" class="shou-item__head">
        <text v-if="item.title" class="shou-item__label">{{ item.title }}</text>
        <text v-if="item.meta" class="shou-sub shou-item__meta">{{ item.meta }}</text>
      </view>
      <view v-if="item.text" class="shou-item__text">{{ item.text }}</view>
      <view v-if="item.detail" class="shou-item__detail">{{ item.detail }}</view>
    </view>

    <view v-if="pending.permissionCount" class="shou-approve">
      <view class="shou-sub shou-approve__desc">{{ pending.description || pending.toolName }}</view>
      <view class="shou-approve__row">
        <view class="shou-btn shou-btn--ghost" @tap="resolve('reject')">{{ t('reject') }}</view>
        <view class="shou-btn" @tap="resolve('approve')">{{ t('approve') }}</view>
      </view>
    </view>

    <view v-if="state.writeEnabled" class="shou-composer">
      <textarea
        class="shou-textarea"
        :value="draft"
        :placeholder="t('newTaskHint')"
        placeholder-class="shou-placeholder"
        :auto-height="true"
        @input="onInput" />
      <view class="shou-btn shou-composer__send" @tap="send">{{ t('send') }}</view>
    </view>
    <view v-else class="shou-locked">{{ t('writeDisabled') }}</view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { state, themeClass, t, endpoints } from '../../store/app.js'
import {
  bridgeErrorOf,
  ensureBridge,
  readRows,
  resolveInteraction,
  sendText,
  sessionFor,
  subscribeConversation,
} from '../../api/session-manager.js'
import { toTimeline } from '../../core/rows.js'
import { safeNavigate } from '../../api/nav.js'
import { formatRelative } from '../../core/session-index.js'

const endpointId = ref('')
const sessionId = ref('')
const title = ref('')
const workspace = ref('')
const workspaceKey = ref('')
const items = ref([])
const draft = ref('')
const busy = ref(false)
const lastError = ref('')
/** 'waiting' | 'ready' | 'timeout' —— 桥接通道的建立状态，界面据此说不同的话。 */
const bridge = ref('waiting')
/** 内容是从哪条路读到的：'bridge' | 'platform' | ''。排错时一眼看出走通了哪条。 */
const via = ref('')

let unsubscribe = null

const pending = computed(() => state.pending?.[endpointId.value]?.[sessionId.value] ?? {})

const statusLine = computed(() => {
  if (lastError.value) return lastError.value
  const row = (state.sessions[endpointId.value] ?? []).find((item) => item.sessionId === sessionId.value)
  const parts = [
    row?.workspace || workspace.value,
    formatRelative(row?.lastActivityAt ?? row?.createdAt, Date.now(), state.lang),
  ].filter(Boolean)
  if (via.value) parts.push(via.value === 'bridge' ? t('viaBridge') : t('viaPlatform'))
  return parts.join(' · ')
})

onLoad((query) => {
  endpointId.value = query?.id ?? ''
  sessionId.value = query?.sessionId ? decodeURIComponent(query.sessionId) : ''
  title.value = query?.title ? decodeURIComponent(query.title) : ''
  workspace.value = query?.workspace ? decodeURIComponent(query.workspace) : ''
  workspaceKey.value = query?.workspaceKey ? decodeURIComponent(query.workspaceKey) : ''
  if (query?.reason) lastError.value = decodeURIComponent(query.reason)

  const endpoint = endpoints.get(endpointId.value)
  if (!endpoint) {
    // 没有端点就没有"正在建立通道"这回事——早先这里直接 return，页面会永远停在等待态。
    lastError.value = t('endpointMissing')
    bridge.value = 'timeout'
    return
  }
  startBridge()
})

function startBridge() {
  bridge.value = 'waiting'
  via.value = ''
  items.value = []
  ensureBridge(endpointId.value, { sessionId: sessionId.value, workspaceKey: workspaceKey.value })
  // 立刻读一次：`readRows` 会自己在"桥接通道"与"platform-request"之间选路，
  // 所以内容不必等桥接就绪——桥接只是实时订阅需要的。
  loadHistory()
  watchChannel()
}

/**
 * 并行等桥接通道，用于订阅实时帧。
 *
 * 等不到也不必把它当失败：内容很可能已经通过 platform-request 读到了，
 * 那种情况下界面照常显示内容，只是没有实时推送。
 */
function watchChannel(tries = 0) {
  if (sessionFor(endpointId.value)?.channel) {
    bridge.value = 'ready'
    unsubscribe?.()
    unsubscribe = subscribeConversation(endpointId.value, sessionId.value, onFrame)
    if (!items.value.length) loadHistory()
    return
  }
  if (tries >= 120) {
    bridge.value = items.value.length ? 'ready' : 'timeout'
    return
  }
  setTimeout(() => watchChannel(tries + 1), 250)
}

function retryBridge() {
  startBridge()
}

onUnload(() => {
  unsubscribe?.()
  unsubscribe = null
})

/**
 * 桥接失败时优先显示**电脑端的原话**。
 *
 * 真机日志里电脑端明确回过「远程 workspace 不在当前窗口中，无法重连」——这种具体原因
 * 直接摆到界面上，用户才知道该去电脑端做什么；换成我们自己的泛泛之词等于把线索扔掉。
 */
const bridgeFailureText = computed(() => {
  const reason = bridgeErrorOf(endpointId.value)
  return reason ? `${t('bridgeRefusedByDesktop')}：${reason}` : t('bridgeFailedHint')
})

const emptyTitle = computed(() => {
  // 失败信息优先：早先这里只看桥接状态，于是读取出错也被"正在建立桥接通道…"盖住，
  // 用户看到的是等待，而真相是已经失败了。
  if (lastError.value) return t('historyFailed')
  if (bridge.value === 'waiting') return t('bridgeWaiting')
  if (bridge.value === 'timeout') return t('bridgeTimeout')
  return t('noTimeline')
})

const emptyBody = computed(() => {
  if (lastError.value) return lastError.value
  if (bridge.value === 'waiting') return t('bridgeWaitingHint')
  if (bridge.value === 'timeout') return bridgeFailureText.value
  return t('noTimelineHint')
})

async function loadHistory() {
  try {
    const result = await readRows(endpointId.value, sessionId.value)
    if (result.payload) {
      const rows = toTimeline(result.payload)
      items.value = rows
      via.value = result.via
      // 拿到载荷却解析不出行，是**解析**问题（多半是字段名对不上），不是"会话为空"。
      // 这两种情况的处理方式完全不同，所以必须分开说，否则我会一直在错误的方向上找原因。
      lastError.value = rows.length ? '' : t('rowsUnparsed')
      return
    }
    if (result.error) lastError.value = `${t('historyFailed')}：${result.error}`
  } catch (error) {
    lastError.value = `${t('historyFailed')}：${error?.message ?? error}`
  }
}

function onFrame(frame) {
  const next = toTimeline(frame)
  if (next.length) items.value = [...items.value, ...next]
}

function openDiag() {
  // 把会话 id 带过去：诊断页那个"用 platform-request 读这条会话"的试探要问对目标，
  // 否则它会去问默认会话，结论对当前问题没有意义。
  safeNavigate(
    `/pages/diag/diag?id=${endpointId.value}&sessionId=${encodeURIComponent(sessionId.value)}`,
    { message: t('openFailed') },
  )
}

function onInput(event) {
  draft.value = event.detail.value
}

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  busy.value = true
  try {
    await sendText(endpointId.value, sessionId.value, text)
    draft.value = ''
    uni.showToast({ title: t('sent'), icon: 'none' })
  } catch (error) {
    uni.showToast({ title: `${t('sendFailed')}：${error?.message ?? error}`, icon: 'none', duration: 2600 })
  } finally {
    busy.value = false
  }
}

async function resolve(outcome) {
  try {
    await resolveInteraction(endpointId.value, sessionId.value, '', outcome)
    uni.showToast({ title: t('sent'), icon: 'none' })
  } catch (error) {
    uni.showToast({ title: `${t('actionFailed')}：${error?.message ?? error}`, icon: 'none', duration: 2600 })
  }
}
</script>

<style scoped>
.shou-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 2px;
}

.shou-bar__name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shou-bar__meta {
  padding: 0 16px 8px;
}

.shou-item__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.shou-item__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--shou-text-hi);
}

.shou-item__meta {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}

.shou-item__detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--shou-danger);
  word-break: break-word;
}

.shou-item__text {
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--shou-text-hi);
}

.shou-item--think .shou-item__text {
  color: var(--shou-text-lo);
  font-style: italic;
}

.shou-item--terminal .shou-item__text,
.shou-item--edit .shou-item__text {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
}

.shou-approve {
  margin: 16px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--shou-danger);
  background: var(--shou-surface);
}

.shou-approve__desc {
  margin-bottom: 12px;
  word-break: break-word;
}

.shou-approve__row {
  display: flex;
  gap: 10px;
}

.shou-approve__row > view {
  flex: 1;
}

.shou-composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 16px 18px;
  background: var(--shou-surface);
  border-top: 1px solid var(--shou-hairline);
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.shou-textarea {
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--shou-text-hi);
}

.shou-composer__send {
  flex: none;
  padding: 10px 18px;
}

.shou-locked {
  margin: 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--shou-text-lo);
}

.shou-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--shou-text-hi);
  margin-bottom: 10px;
}

.shou-empty__btn {
  margin: 20px auto 0;
  max-width: 200px;
}

.shou-empty__row {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}

.shou-empty__row .shou-empty__btn {
  margin: 20px 0 0;
  min-width: 120px;
}

.shou-screen {
  padding-bottom: 120px;
}
</style>
