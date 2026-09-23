<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { httpGet, httpPost } from '../../api/client'
import { themeClass } from '../../theme/theme'

const pin = ref('')
const error = ref('')
const busy = ref(false)

onLoad((options) => {
  // 扫码进入：URL 带 ?pin= 自动登录
  const auto = typeof options?.pin === 'string' ? options.pin : ''
  void bootstrap(auto)
})

async function bootstrap(autoPin: string): Promise<void> {
  try {
    const res = await httpGet<{ ok: boolean }>('/api/bootstrap')
    if (res.statusCode === 200) {
      enter()
      return
    }
    if (res.statusCode === 401 && autoPin) {
      await login(autoPin)
    }
  } catch {
    error.value = '无法连接桌面服务，请确认电脑端已启动'
  }
}

async function login(pinValue: string): Promise<void> {
  if (!pinValue || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await httpPost<{ ok: boolean }>('/api/login', { pin: pinValue })
    if (res.statusCode === 200) {
      enter()
      return
    }
    error.value = res.statusCode === 429 ? '尝试过多，请 1 分钟后再试' : 'PIN 不正确'
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    busy.value = false
    pin.value = ''
  }
}

function enter(): void {
  uni.reLaunch({ url: '/pages/index/index' })
}
</script>

<template>
  <view class="zp-page" :class="themeClass">
    <view class="login-wrap">
      <view class="login-card">
        <text class="login-title">ZCode Phone</text>
        <text class="login-sub">输入电脑端显示的 PIN 完成配对</text>
        <input
          v-model="pin"
          class="login-input"
          type="number"
          :password="true"
          maxlength="8"
          placeholder="8 位 PIN"
          placeholder-class="login-ph"
          confirm-type="go"
          @confirm="() => login(pin)"
        />
        <button class="login-btn" :disabled="busy || !pin" @tap="() => login(pin)">
          {{ busy ? '连接中…' : '连 接' }}
        </button>
        <text v-if="error" class="login-error">{{ error }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 340px;
  background: var(--zp-bg-elev);
  border: 1px solid var(--zp-border);
  border-radius: 16px;
  padding: 28px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.login-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--zp-text);
}
.login-sub {
  margin-top: 8px;
  font-size: 13px;
  color: var(--zp-text-dim);
  text-align: center;
}
.login-input {
  margin-top: 22px;
  width: 100%;
  height: 46px;
  background: var(--zp-bg-elev2);
  border: 1px solid var(--zp-border);
  border-radius: 10px;
  padding: 0 14px;
  color: var(--zp-text);
  font-size: 18px;
  letter-spacing: 6px;
  text-align: center;
  box-sizing: border-box;
}
.login-ph {
  color: var(--zp-text-faint);
  letter-spacing: 2px;
}
.login-btn {
  margin-top: 16px;
  width: 100%;
  height: 44px;
  line-height: 44px;
  border-radius: 10px;
  background: var(--zp-accent);
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}
.login-btn[disabled] {
  opacity: 0.5;
}
.login-error {
  margin-top: 12px;
  color: var(--zp-err);
  font-size: 13px;
}
</style>
