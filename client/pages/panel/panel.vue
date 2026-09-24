<template>
  <view class="shou-panel" :class="themeClass">
    <view v-if="!supported" class="shou-empty">
      <view class="shou-empty__title">{{ t('panelFailed') }}</view>
      <view>{{ t('panelLocalHint') }}</view>
    </view>

    <view v-else-if="!ready" class="shou-panel__overlay">
      <view class="shou-panel__state">{{ t('panelLoading') }}</view>
      <view class="shou-sub shou-panel__addr">{{ address }}</view>
      <view v-if="slow" class="shou-btn shou-btn--ghost shou-panel__btn" @tap="retry">{{ t('retry') }}</view>
      <view v-if="slow" class="shou-sub shou-panel__addr">{{ t('panelLocalHint') }}</view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onUnload, onHide, onShow } from '@dcloudio/uni-app'
import { themeClass, t, endpoints } from '../../store/app.js'
import { buildDshUrl } from '../../core/dsh-link.js'
import { ensurePanel, hideAll, isSupported, reloadPanel, showPanel } from '../../api/dsh-panel.js'

const endpointId = ref('')
const ready = ref(false)
const slow = ref(false)
const supported = computed(() => isSupported())

const endpoint = computed(() => endpoints.get(endpointId.value))
const address = computed(() => (endpoint.value ? buildDshUrl(endpoint.value, { withPin: false }) : ''))

let slowTimer = null

onLoad((query) => {
  endpointId.value = query?.id ?? ''
  if (!endpoint.value || !supported.value) return
  if (endpoint.value.origin === 'public') {
    uni.showModal({
      title: t('detail'),
      content: t('panelPublicWarning'),
      showCancel: false,
    })
  }
  mount()
})

function mount() {
  if (!endpoint.value) return
  ready.value = false
  slow.value = false
  clearTimeout(slowTimer)
  // dsh 首屏要 20–30 秒（node 启动 + 插件树），超过 8 秒还没 loaded 就给用户一个重试入口，
  // 而不是让他对着白屏猜。
  slowTimer = setTimeout(() => {
    slow.value = true
  }, 8000)

  ensurePanel(endpoint.value, {
    onLoaded: () => {
      ready.value = true
      clearTimeout(slowTimer)
    },
    onFailed: () => {
      slow.value = true
      clearTimeout(slowTimer)
    },
  })
  showPanel(endpoint.value, {
    onLoaded: () => {
      ready.value = true
      clearTimeout(slowTimer)
    },
  })
}

function retry() {
  if (!endpoint.value) return
  slow.value = false
  reloadPanel(endpoint.value, {
    onLoaded: () => {
      ready.value = true
      clearTimeout(slowTimer)
    },
  })
}

onShow(() => {
  if (endpoint.value) mount()
})

onHide(() => hideAll())
onUnload(() => {
  clearTimeout(slowTimer)
  hideAll()
})
</script>

<style scoped>
.shou-panel {
  min-height: 100vh;
  background: var(--shou-bg);
}

.shou-panel__overlay {
  padding: 48px 24px;
  text-align: center;
}

.shou-panel__state {
  font-size: 15px;
  font-weight: 600;
  color: var(--shou-text-hi);
}

.shou-panel__addr {
  margin-top: 10px;
  word-break: break-all;
}

.shou-panel__btn {
  margin: 20px auto 0;
  max-width: 200px;
}

.shou-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--shou-text-hi);
  margin-bottom: 10px;
}
</style>
