<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-bar">
      <view class="shou-dot" :style="{ background: ledColor }"></view>
      <view class="shou-title shou-bar__name">{{ endpoint?.label || endpoint?.id || '' }}</view>
      <view class="shou-sub shou-bar__status">{{ statusText }}</view>
      <view class="shou-chip" @tap="openDiag">{{ t('diag') }}</view>
    </view>

    <view v-if="!groups.length" class="shou-empty">
      <view class="shou-empty__title">{{ t('noTasks') }}</view>
      <view>{{ t('noTasksHint') }}</view>
    </view>

    <view v-for="group in groups" :key="group.key">
      <view class="shou-section-label">{{ groupLabel(group.key) }}</view>
      <view
        v-for="task in group.items"
        :key="task.sessionId"
        class="shou-card shou-task"
        @tap="open(task)">
        <view class="shou-task__top">
          <view class="shou-title shou-task__title">{{ task.title || task.sessionId }}</view>
          <view v-if="task.permissionCount" class="shou-pill shou-pill--error">{{ task.permissionCount }}</view>
          <view v-else-if="task.userInputCount" class="shou-pill shou-pill--count">{{ task.userInputCount }}</view>
          <view v-if="phasePill(task)" class="shou-pill" :class="phasePill(task).cls">
            {{ phasePill(task).text }}
          </view>
        </view>
        <view class="shou-sub shou-task__meta">
          {{ [task.workspace, relative(task.lastActivityAt ?? task.createdAt)].filter(Boolean).join(' · ') }}
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { state, themeClass, t, endpoints, indexOf, recompute } from '../../store/app.js'
import { connectEndpoint, statusOf, ensureBridge } from '../../api/session-manager.js'
import { safeNavigate } from '../../api/nav.js'
import { isDone, isError, isRunning, formatRelative, groupLabel as labelOf } from '../../core/session-index.js'
import { LED_ERROR, LED_LIVE, LED_LOADING } from '../../core/relay-led.js'

const endpointId = ref('')
const endpoint = computed(() => endpoints.get(endpointId.value))
const groups = computed(() => state.groups[endpointId.value] ?? [])

onLoad((query) => {
  endpointId.value = query?.id ?? ''
})

onShow(() => {
  const current = endpoint.value
  if (!current) return
  connectEndpoint(current)
  // 冷启动时索引可能是空的；只要还没收到过任务就主动重建一次，
  // 避免"明明有任务却显示空列表"。
  if (!state.groups[endpointId.value]) recompute(endpointId.value)
})

const ledColor = computed(() => {
  const led = state.led[endpointId.value] ?? LED_LOADING
  if (led === LED_LIVE) return 'var(--shou-live)'
  if (led === LED_ERROR) return 'var(--shou-danger)'
  return 'var(--shou-accent)'
})

const statusText = computed(() => {
  const status = statusOf(endpointId.value)
  if (status === 'paired') return t('connected')
  if (status === 'waiting') return t('waitingDesktop')
  if (status === 'expired') return t('pairingExpired')
  return t('connecting')
})

function groupLabel(key) {
  return labelOf(key, state.lang)
}

function openDiag() {
  safeNavigate(`/pages/diag/diag?id=${endpointId.value}`, { message: t('openFailed') })
}

function relative(ts) {
  return formatRelative(ts, Date.now(), state.lang)
}

function phasePill(task) {
  if (isRunning(task.phase)) return { cls: 'shou-pill--running', text: t('connected') }
  if (isDone(task.phase)) return { cls: 'shou-pill--done', text: state.lang === 'en' ? 'Done' : '已完成' }
  if (isError(task.phase)) return { cls: 'shou-pill--error', text: state.lang === 'en' ? 'Failed' : '失败' }
  return null
}

function open(task) {
  // 先确保工作区桥接打开：会话内容只能通过桥接读，而桥接要用完整的工作区键。
  // 失败原因（电脑端的原话）会由 session-manager 记下来，会话页直接显示。
  ensureBridge(endpointId.value, {
    sessionId: task.sessionId,
    workspaceKey: task.workspaceKey,
  })
  safeNavigate(
    `/pages/session/session?id=${endpointId.value}` +
      `&sessionId=${encodeURIComponent(task.sessionId)}` +
      `&title=${encodeURIComponent(task.title || '')}` +
      `&workspace=${encodeURIComponent(task.workspace || '')}` +
      `&workspaceKey=${encodeURIComponent(task.workspaceKey || '')}`,
    { message: t('openFailed') },
  )
}

// indexOf 在模板里用到前先确保存在，避免首次进入时读到 undefined。
indexOf(endpointId.value || 'none')
</script>

<style scoped>
.shou-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 4px;
}

.shou-bar__name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shou-bar__status {
  flex: none;
}

.shou-task__top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shou-task__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shou-task__meta {
  margin-top: 6px;
}

.shou-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--shou-text-hi);
  margin-bottom: 10px;
}
</style>
