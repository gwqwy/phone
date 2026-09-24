<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-section-label">{{ t('general') }}</view>

    <view class="shou-card">
      <view class="shou-set">
        <view class="shou-title">{{ t('language') }}</view>
        <view class="shou-seg">
          <view
            v-for="option in langOptions"
            :key="option.value"
            class="shou-seg__item"
            :class="{ 'shou-seg__item--on': state.langMode === option.value }"
            @tap="setLangMode(option.value)">
            {{ option.label }}
          </view>
        </view>
      </view>

      <view class="shou-set shou-set--gap">
        <view class="shou-title">{{ t('theme') }}</view>
        <view class="shou-seg">
          <view
            v-for="option in themeOptions"
            :key="option.value"
            class="shou-seg__item"
            :class="{ 'shou-seg__item--on': state.themeMode === option.value }"
            @tap="setThemeMode(option.value)">
            {{ option.label }}
          </view>
        </view>
      </view>
    </view>

    <view class="shou-section-label">{{ t('security') }}</view>
    <view class="shou-card">
      <view class="shou-set">
        <view class="shou-set__row">
          <view>
            <view class="shou-title">{{ t('appLock') }}</view>
            <view class="shou-sub">{{ t('appLockHint') }}</view>
          </view>
          <switch :checked="lockOn" color="#35D0E0" @change="toggleLock" />
        </view>
        <view v-if="lockOn" class="shou-link" @tap="changePasscode">{{ t('appLockChange') }}</view>
      </view>
    </view>

    <view class="shou-section-label">{{ t('background') }}</view>
    <view class="shou-card">
      <view class="shou-set__row">
        <view>
          <view class="shou-title">{{ t('keepAlive') }}</view>
          <view class="shou-sub">{{ t('keepAliveHint') }}</view>
        </view>
        <switch :checked="state.keepAlive" color="#35D0E0" @change="toggleKeepAlive" />
      </view>
      <view class="shou-set__row shou-set--gap">
        <view>
          <view class="shou-title">{{ t('batteryWhitelist') }}</view>
          <view class="shou-sub">{{ batteryText }}</view>
        </view>
        <view class="shou-link" @tap="requestBattery">{{ t('openSettings') }}</view>
      </view>
    </view>

    <view class="shou-section-label">{{ t('notifications') }}</view>
    <view class="shou-card">
      <view class="shou-set__row">
        <view class="shou-title">{{ t('notifyApproval') }}</view>
        <switch :checked="state.notify.approval" color="#35D0E0" @change="(e) => setNotify('approval', e.detail.value)" />
      </view>
      <view class="shou-set__row">
        <view class="shou-title">{{ t('notifyComplete') }}</view>
        <switch :checked="state.notify.complete" color="#35D0E0" @change="(e) => setNotify('complete', e.detail.value)" />
      </view>
      <view class="shou-set__row">
        <view class="shou-title">{{ t('notifyFail') }}</view>
        <switch :checked="state.notify.fail" color="#35D0E0" @change="(e) => setNotify('fail', e.detail.value)" />
      </view>
      <view class="shou-sub shou-note">{{ t('notifyHint') }}</view>
    </view>

    <view class="shou-section-label">{{ t('writeToggle') }}</view>
    <view class="shou-card">
      <view class="shou-set__row">
        <view class="shou-title">{{ t('writeToggle') }}</view>
        <switch :checked="state.writeEnabled" color="#35D0E0" @change="toggleWrite" />
      </view>
      <view class="shou-sub shou-note">{{ t('writeHint') }}</view>
    </view>

    <view class="shou-section-label">{{ t('about') }}</view>
    <view class="shou-card">
      <view class="shou-set__row">
        <view class="shou-title">{{ t('version') }}</view>
        <view class="shou-sub">{{ version }}</view>
      </view>
      <view class="shou-sub shou-note">{{ t('upstreamNote') }}</view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import {
  state,
  themeClass,
  t,
  setThemeMode,
  setLangMode,
  setNotify,
  setKeepAlive,
  setWriteEnabled,
  setPasscode,
  clearPasscode,
  lockEnabled,
} from '../../store/app.js'
import { applyKeepAlive, isIgnoringBatteryOptimizations, requestBatteryExemption } from '../../api/keepalive.js'

const version = ref('0.1.0')
const battery = ref(null)

onShow(() => {
  battery.value = isIgnoringBatteryOptimizations()
})

const lockOn = computed(() => lockEnabled())

const langOptions = computed(() => [
  { value: 'system', label: t('langSystem') },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
])

const themeOptions = computed(() => [
  { value: 'dark', label: t('themeDark') },
  { value: 'light', label: t('themeLight') },
  { value: 'system', label: t('themeSystem') },
])

const batteryText = computed(() => {
  if (battery.value === true) return '已在白名单'
  if (battery.value === null) return t('batteryWhitelistHint')
  return t('batteryWhitelistHint')
})

function toggleKeepAlive(event) {
  setKeepAlive(event.detail.value)
  applyKeepAlive()
}

function toggleWrite(event) {
  setWriteEnabled(event.detail.value)
}

function requestBattery() {
  requestBatteryExemption()
}

function toggleLock(event) {
  if (!event.detail.value) {
    uni.showModal({
      title: t('appLockClear'),
      content: t('appLockHint'),
      success: ({ confirm }) => {
        if (confirm) clearPasscode()
      },
    })
    return
  }
  promptPasscode((value) => setPasscode(value))
}

function changePasscode() {
  promptPasscode((value) => setPasscode(value))
}

function promptPasscode(onDone) {
  uni.showModal({
    title: t('appLockSet'),
    editable: true,
    placeholderText: t('appLockPrompt'),
    success: ({ confirm, content }) => {
      if (!confirm) return
      if (!content || content.length < 4) {
        uni.showToast({ title: t('appLockWrong'), icon: 'none' })
        return
      }
      onDone(content)
      uni.showToast({ title: t('save') + ' ✓', icon: 'none' })
    },
  })
}
</script>

<style scoped>
.shou-set__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.shou-set--gap {
  margin-top: 16px;
}

.shou-seg {
  display: flex;
  margin-top: 10px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--shou-hairline);
}

.shou-seg__item {
  flex: 1;
  text-align: center;
  padding: 8px 0;
  font-size: 13px;
  color: var(--shou-text-lo);
  background: var(--shou-field);
}

.shou-seg__item--on {
  background: var(--shou-surface-hi);
  color: var(--shou-text-hi);
  font-weight: 600;
}

.shou-link {
  margin-top: 10px;
  font-size: 13px;
  color: var(--shou-accent);
}

.shou-note {
  margin-top: 10px;
  line-height: 1.7;
}
</style>
