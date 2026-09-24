<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-section-label">{{ t('overview') }}</view>

    <view v-if="!blocks.length" class="shou-empty">
      <view class="shou-empty__title">{{ t('noSessions') }}</view>
      <view>{{ t('emptyEndpointsHint') }}</view>
    </view>

    <view v-for="block in blocks" :key="block.id">
      <view class="shou-group">
        <view class="shou-dot" :style="{ background: block.color }"></view>
        <view class="shou-title">{{ block.label }}</view>
        <view class="shou-sub">{{ block.count }}</view>
      </view>

      <view
        v-for="row in block.rows"
        :key="row.sessionId"
        class="shou-card shou-row-card"
        @tap="open(block.id, row)">
        <view class="shou-row-card__main">
          <view class="shou-title shou-row-card__title">{{ row.title || row.sessionId }}</view>
          <view class="shou-sub shou-row-card__meta">
            {{ [row.workspace, relative(row)].filter(Boolean).join(' · ') }}
          </view>
        </view>
        <view v-if="row.permissionCount" class="shou-pill shou-pill--error">{{ row.permissionCount }}</view>
        <view v-else-if="row.userInputCount" class="shou-pill shou-pill--count">{{ row.userInputCount }}</view>
        <view v-if="pill(row)" class="shou-pill" :class="pill(row).cls">{{ pill(row).text }}</view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { state, themeClass, t, refreshList, selectEndpoint } from '../../store/app.js'
import { safeNavigate } from '../../api/nav.js'
import { formatRelative, isDone, isError, isRunning } from '../../core/session-index.js'
import { LED_ERROR, LED_LIVE, LED_LOADING } from '../../core/relay-led.js'
import { ENDPOINT_KIND_RELAY } from '../../core/pairing-link.js'

onShow(() => refreshList())

/** 跨端点汇总：每个端点一段，段内按时间倒序（排序规则在索引层已经统一）。 */
const blocks = computed(() => {
  const out = []
  for (const endpoint of state.list) {
    const rows = state.sessions[endpoint.id] ?? []
    if (!rows.length) continue
    out.push({
      id: endpoint.id,
      label: endpoint.label || endpoint.id,
      count: rows.length,
      color: ledColor(endpoint.id),
      rows,
    })
  }
  return out
})

function ledColor(id) {
  const led = state.led[id] ?? LED_LOADING
  if (led === LED_LIVE) return 'var(--shou-live)'
  if (led === LED_ERROR) return 'var(--shou-danger)'
  return 'var(--shou-accent)'
}

function relative(row) {
  return formatRelative(row.lastActivityAt ?? row.createdAt, Date.now(), state.lang)
}

function pill(row) {
  if (isRunning(row.phase)) return { cls: 'shou-pill--running', text: state.lang === 'en' ? 'Running' : '运行中' }
  if (isDone(row.phase)) return { cls: 'shou-pill--done', text: state.lang === 'en' ? 'Done' : '已完成' }
  if (isError(row.phase)) return { cls: 'shou-pill--error', text: state.lang === 'en' ? 'Failed' : '失败' }
  return null
}

function open(endpointId, row) {
  selectEndpoint(endpointId)
  const endpoint = state.list.find((item) => item.id === endpointId)
  safeNavigate(
    endpoint?.kind === ENDPOINT_KIND_RELAY
      ? `/pages/session/session?id=${endpointId}` +
          `&sessionId=${encodeURIComponent(row.sessionId)}` +
          `&title=${encodeURIComponent(row.title || '')}` +
          `&workspace=${encodeURIComponent(row.workspace || '')}` +
          `&workspaceKey=${encodeURIComponent(row.workspaceKey || '')}`
      : `/pages/panel/panel?id=${endpointId}`,
    { message: t('openFailed') },
  )
}
</script>

<style scoped>
.shou-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 6px;
}

.shou-group .shou-sub {
  margin-left: auto;
}

.shou-row-card {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shou-row-card__main {
  flex: 1;
  min-width: 0;
}

.shou-row-card__title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shou-row-card__meta {
  margin-top: 4px;
}

.shou-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--shou-text-hi);
  margin-bottom: 10px;
}
</style>
