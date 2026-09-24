<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-header">
      <view>
        <view class="shou-brand">shou</view>
        <view class="shou-header__sub">{{ t('endpointsCount', list.length) }}</view>
      </view>
      <view class="shou-header__actions">
        <view class="shou-chip" @tap="goOverview">{{ t('overview') }}</view>
        <view class="shou-chip" @tap="goSettings">{{ t('settings') }}</view>
      </view>
    </view>

    <view v-if="!list.length" class="shou-empty">
      <view class="shou-empty__title">{{ t('emptyEndpoints') }}</view>
      <view>{{ t('emptyEndpointsHint') }}</view>
    </view>

    <view v-else>
      <view class="shou-section-label">{{ t('endpoints') }}</view>
      <view
        v-for="endpoint in list"
        :key="endpoint.id"
        class="shou-card shou-endpoint"
        @tap="open(endpoint)"
        @longpress="menu(endpoint)">
        <view class="shou-endpoint__main">
          <view class="shou-endpoint__row">
            <view class="shou-dot" :style="{ background: ledColor(endpoint.id) }"></view>
            <view class="shou-title shou-endpoint__name">{{ endpoint.label || endpoint.id }}</view>
            <view v-if="unread(endpoint.id)" class="shou-pill shou-pill--error">{{ unread(endpoint.id) }}</view>
          </view>
          <view class="shou-sub shou-endpoint__meta">
            {{ describe(endpoint) }} · {{ kindLabel(endpoint) }}
          </view>
          <view class="shou-sub shou-endpoint__status">{{ statusText(endpoint) }}</view>
          <view v-if="hintFor(endpoint)" class="shou-endpoint__hint">{{ hintFor(endpoint) }}</view>
        </view>
        <view class="shou-endpoint__more" @tap.stop="menu(endpoint)">⋯</view>
      </view>

      <view class="shou-manage">
        <view class="shou-btn shou-btn--ghost" @tap="manageAll">{{ t('manage') }}</view>
      </view>
    </view>

    <view class="shou-fabbar">
      <view class="shou-btn shou-btn--ghost shou-fabbar__small" @tap="pasteLink">{{ t('paste') }}</view>
      <view class="shou-btn shou-fabbar__main" @tap="scanCode">{{ t('scan') }}</view>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import {
  state,
  themeClass,
  t,
  refreshList,
  selectEndpoint,
  removeEndpoint,
  renameEndpoint,
  replaceEndpointLink,
  importEndpoint,
} from '../../store/app.js'
import { connectEndpoint, statusOf, disconnectEndpoint } from '../../api/session-manager.js'
import { safeNavigate } from '../../api/nav.js'
import { activeCount, clearEndpoint } from '../../api/notify.js'
import { ENDPOINT_KIND_RELAY } from '../../core/pairing-link.js'
import { LED_ERROR, LED_LIVE, LED_LOADING } from '../../core/relay-led.js'

const list = computed(() => state.list)

onShow(() => {
  refreshList()
  for (const endpoint of state.list) {
    if (endpoint.kind === ENDPOINT_KIND_RELAY) connectEndpoint(endpoint)
  }
})

function ledColor(id) {
  const led = state.led[id] ?? LED_LOADING
  if (led === LED_LIVE) return 'var(--shou-live)'
  if (led === LED_ERROR) return 'var(--shou-danger)'
  return 'var(--shou-accent)'
}

function unread(id) {
  return activeCount(id)
}

function describe(endpoint) {
  if (endpoint.kind === ENDPOINT_KIND_RELAY) {
    const sid = endpoint.params?.sid ?? ''
    return sid ? `sid …${sid.slice(-6)}` : t('notPairedYet')
  }
  return endpoint.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function kindLabel(endpoint) {
  if (endpoint.kind === ENDPOINT_KIND_RELAY) return 'ZCode'
  return endpoint.origin === 'local' ? 'dsh · 本机' : 'dsh'
}

function statusText(endpoint) {
  if (endpoint.kind !== ENDPOINT_KIND_RELAY) return t('detail')
  const status = statusOf(endpoint.id)
  if (status === 'paired') return t('connected')
  if (status === 'waiting') return t('waitingDesktop')
  if (status === 'kicked') return t('kickedStatus')
  if (status === 'expired') return t('pairingExpired')
  return t('connecting')
}

/**
 * 需要用户做点什么的状态才给提示。
 *
 * `waiting` 这个状态特别容易让人以为是自己网络的问题，其实含义很具体：
 * 认证通过了，但电脑端的远控腿不在线——要么那个页面关着，要么二维码已经换了一版而我们手里的是旧的。
 */
function hintFor(endpoint) {
  if (endpoint.kind !== ENDPOINT_KIND_RELAY) return ''
  const status = statusOf(endpoint.id)
  if (status === 'waiting') return t('waitingHint')
  if (status === 'kicked') return t('kickedHint')
  if (status === 'expired') return t('pairingExpiredHint')
  return ''
}

/**
 * 「管理连接」入口：先把端点列一遍让你选，再进同一个操作菜单。
 *
 * 卡片上的 ⋯ 是给"我知道我要改哪一个"的场景；这个入口是给"我要删一个连接"
 * 但不确定点哪里的人——长按这种手势不该是唯一途径。
 */
function manageAll() {
  if (!list.value.length) return
  const shown = list.value.slice(0, 6)
  if (shown.length === 1) {
    menu(shown[0])
    return
  }
  uni.showActionSheet({
    itemList: shown.map((endpoint) => endpoint.label || describe(endpoint)),
    success: ({ tapIndex }) => {
      const picked = shown[tapIndex]
      if (picked) menu(picked)
    },
  })
}

function open(endpoint) {
  selectEndpoint(endpoint.id)
  clearEndpoint(endpoint.id)
  const url =
    endpoint.kind === ENDPOINT_KIND_RELAY
      ? `/pages/tasks/tasks?id=${endpoint.id}`
      : `/pages/panel/panel?id=${endpoint.id}`
  safeNavigate(url, { message: t('openFailed') })
}

function menu(endpoint) {
  uni.showActionSheet({
    itemList: [t('rename'), t('replaceLink'), t('remove')],
    success: ({ tapIndex }) => {
      if (tapIndex === 0) rename(endpoint)
      else if (tapIndex === 1) replace(endpoint)
      else remove(endpoint)
    },
  })
}

function rename(endpoint) {
  uni.showModal({
    title: t('rename'),
    editable: true,
    placeholderText: endpoint.label,
    success: ({ confirm, content }) => {
      if (confirm) renameEndpoint(endpoint.id, content ?? '')
    },
  })
}

function replace(endpoint) {
  uni.showModal({
    title: t('replaceLink'),
    editable: true,
    placeholderText: t('pastePlaceholder'),
    success: ({ confirm, content }) => {
      if (!confirm || !content) return
      const next = replaceEndpointLink(endpoint.id, content)
      if (!next) {
        uni.showToast({ title: t('importInvalid'), icon: 'none', duration: 2600 })
        return
      }
      disconnectEndpoint(endpoint.id)
      connectEndpoint(next)
      uni.showToast({ title: t('importOk'), icon: 'none' })
    },
  })
}

function remove(endpoint) {
  uni.showModal({
    title: t('removeConfirm'),
    content: t('removeConfirmBody'),
    confirmText: t('remove'),
    success: ({ confirm }) => {
      if (!confirm) return
      disconnectEndpoint(endpoint.id)
      removeEndpoint(endpoint.id)
      // 顺手把它的通知清掉，否则会留下点不开的通知。
      clearEndpoint(endpoint.id)
      uni.showToast({ title: t('removeDone'), icon: 'none' })
    },
  })
}

function scanCode() {
  uni.scanCode({
    success: ({ result }) => {
      importText(result)
    },
    fail: () => {
      uni.showToast({ title: t('importInvalid'), icon: 'none' })
    },
  })
}

function pasteLink() {
  uni.navigateTo({ url: '/pages/import/import' })
}

function importText(text) {
  toastForImport(importEndpoint(text))
}

function toastForImport(result) {
  if (result.status === 'added') uni.showToast({ title: t('importOk'), icon: 'none' })
  else if (result.status === 'duplicate') uni.showToast({ title: t('importDuplicate'), icon: 'none' })
  else uni.showToast({ title: t('importInvalid'), icon: 'none', duration: 2600 })
}

function goOverview() {
  uni.navigateTo({ url: '/pages/overview/overview' })
}

function goSettings() {
  uni.navigateTo({ url: '/pages/settings/settings' })
}
</script>

<style scoped>
.shou-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 18px 16px 6px;
}

.shou-brand {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.5px;
  color: var(--shou-text-hi);
}

.shou-header__sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--shou-text-lo);
}

.shou-header__actions {
  display: flex;
  gap: 8px;
}

.shou-chip {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--shou-hairline);
  font-size: 12px;
  color: var(--shou-text-lo);
}

.shou-endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.shou-endpoint__main {
  flex: 1;
  min-width: 0;
}

.shou-endpoint__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shou-endpoint__name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.shou-endpoint__meta {
  margin-top: 6px;
}

.shou-endpoint__status {
  margin-top: 2px;
  color: var(--shou-text-lo);
  opacity: 0.8;
}

.shou-endpoint__chevron {
  font-size: 22px;
  color: var(--shou-text-lo);
  padding-left: 10px;
}

.shou-endpoint__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--shou-danger);
}

.shou-endpoint__more {
  flex: none;
  padding: 0 6px 0 14px;
  font-size: 20px;
  line-height: 1;
  color: var(--shou-text-lo);
}

.shou-manage {
  margin: 6px 16px 0;
}

.shou-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--shou-text-hi);
  margin-bottom: 10px;
}

.shou-fabbar {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: 24px;
  display: flex;
  gap: 10px;
}

.shou-fabbar__small {
  flex: none;
  padding: 12px 18px;
}

.shou-fabbar__main {
  flex: 1;
}

.shou-screen {
  padding-bottom: 110px;
}
</style>
