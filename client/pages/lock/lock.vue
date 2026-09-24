<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-lock">
      <view class="shou-lock__mark">shou</view>
      <view class="shou-lock__title">{{ t('appLock') }}</view>
      <view class="shou-lock__sub">{{ t('appLockPrompt') }}</view>

      <input
        class="shou-lock__input"
        type="password"
        :password="true"
        :value="passcode"
        :focus="true"
        @input="onInput"
        @confirm="submit" />

      <view v-if="error" class="shou-lock__error">{{ t('appLockWrong') }}</view>

      <view class="shou-btn shou-lock__btn" @tap="submit">{{ t('confirm') }}</view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue'
import { state, themeClass, t, verifyPasscode } from '../../store/app.js'

const passcode = ref('')
const error = ref(false)

function onInput(event) {
  passcode.value = event.detail.value
  error.value = false
}

function submit() {
  if (verifyPasscode(passcode.value)) {
    state.unlocked = true
    error.value = false
    const pages = getCurrentPages()
    if (pages.length > 1) uni.navigateBack()
    else uni.reLaunch({ url: '/pages/index/index' })
    return
  }
  error.value = true
  passcode.value = ''
}
</script>

<style scoped>
.shou-lock {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 32px;
}

.shou-lock__mark {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 4px;
  color: var(--shou-accent);
}

.shou-lock__title {
  margin-top: 28px;
  font-size: 24px;
  font-weight: 700;
  color: var(--shou-text-hi);
}

.shou-lock__sub {
  margin-top: 8px;
  font-size: 13px;
  color: var(--shou-text-lo);
}

.shou-lock__input {
  margin-top: 24px;
  width: 100%;
  max-width: 320px;
  height: 48px;
  padding: 0 14px;
  box-sizing: border-box;
  border-radius: 12px;
  border: 1px solid var(--shou-hairline);
  background: var(--shou-field);
  color: var(--shou-text-hi);
  font-size: 16px;
  text-align: center;
}

.shou-lock__error {
  margin-top: 12px;
  font-size: 13px;
  color: var(--shou-danger);
}

.shou-lock__btn {
  margin-top: 20px;
  width: 100%;
  max-width: 320px;
}
</style>
