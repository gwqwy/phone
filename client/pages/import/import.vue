<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-empty">{{ t('pasteHint') }}</view>

    <view class="shou-field">
      <textarea
        class="shou-textarea"
        :value="text"
        :placeholder="t('pastePlaceholder')"
        placeholder-class="shou-placeholder"
        :auto-height="true"
        :maxlength="-1"
        @input="onInput" />
    </view>

    <view class="shou-actions">
      <view class="shou-btn shou-btn--ghost" @tap="fromClipboard">{{ t('paste') }}</view>
      <view class="shou-btn" @tap="submit">{{ t('confirm') }}</view>
    </view>

    <view class="shou-hint">{{ t('upstreamNote') }}</view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { themeClass, t, importEndpoint } from '../../store/app.js'

const text = ref('')

function onInput(event) {
  text.value = event.detail.value
}

function fromClipboard() {
  uni.getClipboardData({
    success: ({ data }) => {
      if (data) text.value = String(data).trim()
    },
  })
}

function submit() {
  const result = importEndpoint(text.value)
  if (result.status === 'invalid') {
    uni.showToast({ title: t('importInvalid'), icon: 'none', duration: 2800 })
    return
  }
  uni.showToast({
    title: result.status === 'duplicate' ? t('importDuplicate') : t('importOk'),
    icon: 'none',
  })
  setTimeout(() => {
    const pages = getCurrentPages()
    if (pages.length > 1) uni.navigateBack()
    else uni.reLaunch({ url: '/pages/index/index' })
  }, 600)
}
</script>

<style scoped>
.shou-field {
  margin: 0 16px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--shou-hairline);
  background: var(--shou-field);
}

.shou-textarea {
  width: 100%;
  min-height: 96px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--shou-text-hi);
}

.shou-placeholder {
  color: var(--shou-text-lo);
}

.shou-actions {
  display: flex;
  gap: 10px;
  margin: 16px;
}

.shou-actions > view {
  flex: 1;
}

.shou-hint {
  margin: 8px 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--shou-text-lo);
}
</style>
