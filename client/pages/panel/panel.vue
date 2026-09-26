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

    <view v-if="isLocal" class="shou-card shou-dsh">
      <view class="shou-title">{{ t('dshPhone') }}</view>

      <template v-if="pluginAvailable">
        <view class="shou-sub shou-dsh__hint">{{ t('pluginDeployHint') }}</view>
        <view class="shou-dsh__status">{{ pluginStatusText }}</view>
        <input
          class="shou-dsh__input"
          :value="apiKey"
          :placeholder="t('pluginApiKeyPlaceholder')"
          placeholder-class="shou-dsh__ph"
          password
          @input="onApiKey" />
        <view class="shou-dsh__actions">
          <view class="shou-btn" :class="{ 'shou-btn--busy': deploying }" @tap="deployViaPlugin">
            {{ deploying ? t('pluginDeploying') : t('pluginDeploy') }}
          </view>
          <view v-if="pluginState.dshWebListening" class="shou-btn shou-btn--ghost" @tap="restartViaPlugin">
            {{ t('pluginRestart') }}
          </view>
        </view>
        <view v-if="progressLines.length" class="shou-dsh__log">
          <view v-for="(line, index) in progressLines" :key="index" class="shou-dsh__logline">{{ line }}</view>
        </view>
      </template>

      <template v-else>
        <view class="shou-sub shou-dsh__hint">{{ t('dshPhoneHint') }}</view>
        <view class="shou-dsh__status">{{ dshStatusText }}</view>
        <view v-if="installing.phase" class="shou-sub shou-dsh__phase">{{ installing.phase }}</view>
        <view class="shou-dsh__actions">
          <view v-if="!dshPhone.installed" class="shou-btn" :class="{ 'shou-btn--busy': installing.busy }" @tap="installDsh">
            {{ installing.busy ? t('dshPhoneChecking') : t('installDshPhone') }}
          </view>
          <view v-else class="shou-btn" @tap="openDsh">{{ t('openDshPhone') }}</view>
        </view>
        <view class="shou-sub shou-dsh__hint">{{ t('dshDeployHint') }}</view>
      </template>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onUnload, onHide, onShow } from '@dcloudio/uni-app'
import { themeClass, t, endpoints } from '../../store/app.js'
import { buildDshUrl } from '../../core/dsh-link.js'
import { ensurePanel, hideAll, isSupported, reloadPanel, showPanel } from '../../api/dsh-panel.js'
import {
  downloadAndInstall,
  fetchLatestRelease,
  formatSize,
  installedVersion,
  isInstalled,
  isSupported as dshPhoneSupported,
  openDshPhone,
} from '../../api/dsh-phone.js'
import {
  deployWithPlugin,
  describeStatus,
  hasPlugin,
  pluginStatus,
  restartWithPlugin,
} from '../../api/dsh-plugin.js'

const endpointId = ref('')
const ready = ref(false)
const slow = ref(false)
const supported = computed(() => isSupported())

const endpoint = computed(() => endpoints.get(endpointId.value))
const address = computed(() => (endpoint.value ? buildDshUrl(endpoint.value, { withPin: false }) : ''))

/** 本机 dsh 才需要在 shou 里装部署器；局域网/公网端点由电脑端负责。 */
const isLocal = computed(() => endpoint.value?.origin === 'local')
const dshPhone = ref({ supported: true, installed: false, version: '' })
const installing = ref({ busy: false, phase: '' })

const dshStatusText = computed(() => {
  if (!dshPhone.value.supported) return t('dshNoSupport')
  if (!dshPhone.value.installed) return t('dshPhoneMissing')
  return dshPhone.value.version ? `${t('dshPhoneInstalled')} · v${dshPhone.value.version}` : t('dshPhoneInstalled')
})

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
  refreshDshPhone()
  refreshPlugin()
  mount()
})

/** 查一遍部署器的安装状态。回到前台会再查一次——用户可能刚在系统安装器里装完。 */
function refreshDshPhone() {
  if (!isLocal.value) return
  const supportedHere = dshPhoneSupported()
  dshPhone.value = {
    supported: supportedHere,
    installed: supportedHere ? isInstalled() === true : false,
    version: supportedHere ? installedVersion() : '',
  }
}

async function installDsh() {
  if (installing.value.busy) return
  if (!dshPhone.value.supported) {
    uni.showToast({ title: t('dshNoSupport'), icon: 'none' })
    return
  }
  installing.value = { busy: true, phase: t('dshPhoneChecking') }
  try {
    const asset = await fetchLatestRelease()
    installing.value.phase = `${t('dshDownloading')} ${asset.version} · ${formatSize(asset.size)}`
    await downloadAndInstall(asset, (percent) => {
      installing.value.phase =
        percent >= 0 ? `${t('dshDownloading')} ${percent}%` : `${t('dshDownloading')}…`
    })
    installing.value.phase = t('dshInstalling')
    refreshDshPhone()
  } catch (error) {
    uni.showToast({
      title: `${t('dshInstallFailed')}：${error?.message ?? error}`,
      icon: 'none',
      duration: 3200,
    })
    installing.value.phase = ''
  } finally {
    installing.value.busy = false
  }
}

function openDsh() {
  if (!openDshPhone()) uni.showToast({ title: t('dshNoSupport'), icon: 'none' })
}

// ---------------------------------------------------------------------------
// 原生插件路线（优先）
// ---------------------------------------------------------------------------

const pluginAvailable = ref(false)
const pluginState = ref({})
const apiKey = ref('')
const deploying = ref(false)
const progressLines = ref([])

/** 插件给出的状态翻成一句"你现在该做什么"。 */
const pluginStatusText = computed(() => t(describeStatus(pluginState.value).key))

function onApiKey(event) {
  apiKey.value = event.detail.value
}

async function refreshPlugin() {
  pluginAvailable.value = hasPlugin()
  if (!pluginAvailable.value) return
  try {
    pluginState.value = await pluginStatus()
  } catch {
    pluginAvailable.value = false
  }
}

function pushProgress(progress) {
  const text = progress?.step ? `[${progress.step}/${progress.total}] ${progress.message}` : progress?.message
  if (!text) return
  // 只留最近 80 行：这个列表是给人看进度的，不是日志归档。
  progressLines.value = [...progressLines.value.slice(-79), text]
}

async function deployViaPlugin() {
  if (deploying.value) return
  deploying.value = true
  progressLines.value = []
  try {
    const result = await deployWithPlugin({ apiKey: apiKey.value.trim() }, pushProgress)
    pluginState.value = await pluginStatus()
    uni.showToast({ title: t('pluginDeployDone'), icon: 'none' })
    if (result?.dshWebListening) mount()
  } catch (error) {
    uni.showToast({
      title: `${t('pluginDeployFailed')}：${error?.message ?? error}`,
      icon: 'none',
      duration: 3600,
    })
  } finally {
    deploying.value = false
  }
}

async function restartViaPlugin() {
  progressLines.value = []
  try {
    await restartWithPlugin(pushProgress)
    pluginState.value = await pluginStatus()
    mount()
  } catch (error) {
    uni.showToast({
      title: `${t('pluginDeployFailed')}：${error?.message ?? error}`,
      icon: 'none',
      duration: 3200,
    })
  }
}

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
  refreshDshPhone()
  refreshPlugin()
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

.shou-dsh {
  margin-top: 8px;
}

.shou-dsh__hint {
  margin-top: 8px;
  line-height: 1.7;
}

.shou-dsh__status {
  margin-top: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--shou-accent);
}

.shou-dsh__phase {
  margin-top: 6px;
  color: var(--shou-text-hi);
}

.shou-dsh__actions {
  margin-top: 12px;
}

.shou-btn--busy {
  opacity: 0.6;
}

.shou-dsh__input {
  margin-top: 12px;
  height: 44px;
  padding: 0 12px;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid var(--shou-hairline);
  background: var(--shou-field);
  color: var(--shou-text-hi);
  font-size: 14px;
}

.shou-dsh__ph {
  color: var(--shou-text-lo);
}

.shou-dsh__actions {
  display: flex;
  gap: 10px;
}

.shou-dsh__actions > view {
  flex: 1;
}

.shou-dsh__log {
  margin-top: 12px;
  padding: 10px;
  border-radius: 10px;
  background: var(--shou-field);
  max-height: 220px;
  overflow: hidden;
}

.shou-dsh__logline {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--shou-text-lo);
  word-break: break-all;
}
</style>
