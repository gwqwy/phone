<script setup lang="ts">
import { ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import NavBar from '../../components/NavBar.vue'
import { themeClass } from '../../theme/theme'

const sessionId = ref('')

onLoad((options) => {
  sessionId.value = typeof options?.id === 'string' ? options.id : ''
  // M1：订阅 session-stream 并渲染时间线
})

onUnload(() => {})
</script>

<template>
  <view class="zp-page" :class="themeClass">
    <NavBar title="任务会话" :back="true" @back="() => uni.navigateBack()" />
    <view class="body">
      <view class="placeholder">
        <text>时间线渲染将在 M1 实现</text>
        <text class="hint">{{ sessionId }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.body {
  padding: 20px;
}
.placeholder {
  margin-top: 80px;
  text-align: center;
  color: var(--zp-text-faint);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hint {
  font-size: 10px;
  color: var(--zp-text-faint);
  word-break: break-all;
}
</style>
