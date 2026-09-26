<template>
  <view class="shou-screen" :class="themeClass">
    <view class="shou-section-label">{{ t('diag') }}</view>

    <view class="shou-card">
      <view v-for="row in statusRows" :key="row.label" class="shou-diag__row">
        <view class="shou-sub shou-diag__label">{{ row.label }}</view>
        <view class="shou-diag__value" :class="{ 'shou-diag__value--bad': row.bad }">{{ row.value }}</view>
      </view>
    </view>

    <view class="shou-section-label">{{ t('diagProbe') }}</view>
    <view class="shou-card">
      <view class="shou-sub shou-diag__hint">{{ t('diagProbeHint') }}</view>
      <view class="shou-diag__buttons">
        <view
          v-for="probe in probeMethods"
          :key="probe.method"
          class="shou-chip shou-chip--btn"
          @tap="probeMethod(probe)">
          {{ probe.method }}
        </view>
      </view>
      <view v-if="probeResult" class="shou-diag__probe">{{ probeResult }}</view>
    </view>

    <view class="shou-section-label">{{ t('diagCrossCheck') }}</view>
    <view class="shou-card">
      <view class="shou-sub shou-diag__hint">{{ t('diagCrossCheckHint') }}</view>
      <view class="shou-diag__buttons">
        <view class="shou-chip shou-chip--btn" @tap="copyLink">{{ t('copyPairingLink') }}</view>
      </view>
    </view>

    <view class="shou-section-label">{{ t('diagLog') }}</view>
    <view class="shou-card shou-diag__logcard">
      <view v-if="!entries.length" class="shou-sub">{{ t('diagNoLog') }}</view>
      <view v-for="(entry, index) in entries" :key="index" class="shou-diag__line">
        <text class="shou-diag__dir" :class="`shou-diag__dir--${dirClass(entry.direction)}`">
          {{ entry.direction }} {{ clock(entry.at) }}
        </text>
        <text class="shou-diag__text">{{ entry.text }}</text>
      </view>
    </view>

    <view class="shou-diag__actions">
      <view class="shou-btn shou-btn--ghost" @tap="reconnect">{{ t('reconnect') }}</view>
      <view class="shou-btn shou-btn--ghost" @tap="refresh">{{ t('refresh') }}</view>
      <view class="shou-btn" @tap="copyAll">{{ t('copyAll') }}</view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { state, themeClass, t, endpoints } from '../../store/app.js'
import { buildPairingUrl } from '../../core/pairing-link.js'
import {
  bridgeState,
  connectEndpoint,
  disconnectEndpoint,
  logFor,
  resolveWorkspaceKey,
  tryPlatform,
} from '../../api/session-manager.js'

const endpointId = ref('')
const tick = ref(0)
const probeResult = ref('')
/** 从会话页进来时带上的目标会话；没有就退回"桌面端当前活动会话"。 */
const focusSessionId = ref('')

/**
 * 试探用的方法名。
 *
 * 从官方前端 bundle 里查到 `platform-request.method` 是**封闭枚举**，只有下面这些值，
 * 全是 Docker / WSL / SSH / MCP 相关。它**不是**通用 RPC 代理——所以以前拿
 * `v4/conversation/rowsRange` 去问必然是白等超时（那条猜测已删）。
 * 这里只列真实存在的方法：它们能应答就说明这条通道本身是通的；
 * 而会话内容不在这条通道上，只能经桥接读。
 */
const probeMethods = [
  { method: 'isDockerAvailable', args: () => ({}) },
  { method: 'listWSLDistros', args: () => ({}) },
  { method: 'listSSHConfigAliases', args: () => ({}) },
  { method: 'loadMcpFromUserDirectory', args: () => ({}) },
]

onLoad((query) => {
  endpointId.value = query?.id ?? ''
  focusSessionId.value = query?.sessionId ? decodeURIComponent(query.sessionId) : ''
})

onShow(() => refresh())

function refresh() {
  tick.value += 1
}

const endpoint = computed(() => endpoints.get(endpointId.value))

const statusRows = computed(() => {
  tick.value
  const info = bridgeState(endpointId.value)
  const endpointValue = endpoint.value
  const initial = state.initialView?.[endpointId.value]
  const tasks = state.tasks[endpointId.value] ?? []
  const withKey = tasks.filter((task) => task.workspaceKey).length
  return [
    { label: '端点', value: endpointValue?.label || endpointValue?.id || '—' },
    { label: 'sid（与电脑端二维码比对）', value: endpointValue?.params?.sid ?? '—' },
    { label: '状态', value: state.pairStatus?.[endpointId.value] ?? '—', bad: (state.pairStatus?.[endpointId.value] ?? '') === 'expired' },
    { label: '连接灯', value: state.led[endpointId.value] ?? '—' },
    { label: '内部状态机', value: info.state ?? '未连接', bad: !info.connected },
    { label: '桥接通道', value: info.channelReady ? '已就绪' : '未就绪', bad: !info.channelReady },
    { label: '工作区键', value: info.bridge?.workspaceKey ?? '—', bad: !info.bridge?.workspaceKey },
    { label: '桌面端当前工作区', value: initial?.activeWorkspaceKey ?? '—' },
    { label: '任务数', value: `${tasks.length}（其中带完整路径 ${withKey}）`, bad: tasks.length > 0 && withKey === 0 },
    { label: '最近错误', value: state.lastError?.[endpointId.value]?.message ?? '—', bad: Boolean(state.lastError?.[endpointId.value]) },
  ]
})

const entries = computed(() => {
  tick.value
  return logFor(endpointId.value).slice().reverse()
})

function dirClass(direction) {
  if (direction === '→') return 'out'
  if (direction === '←') return 'in'
  if (direction === '!') return 'err'
  return 'state'
}

function clock(at) {
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function probeMethod(probe) {
  probeResult.value = `${probe.method} …`
  try {
    const response = await tryPlatform(endpointId.value, probe.method, probe.args())
    probeResult.value = `${probe.method} → ${JSON.stringify(response).slice(0, 1500)}`
  } catch (error) {
    probeResult.value = `${probe.method} → 失败：${error?.message ?? error}`
  }
}

function copyAll() {
  const lines = statusRows.value.map((row) => `${row.label}: ${row.value}`)
  const log = logFor(endpointId.value)
    .map((entry) => `${entry.direction} ${new Date(entry.at).toISOString()} ${entry.text}`)
    .join('\n')
  const text = [
    `shou ${t('version')} 0.1.0 · ${t('diag')}`,
    ...lines,
    `resolveWorkspaceKey: ${resolveWorkspaceKey(endpointId.value, '') || '(空)'}`,
    '--- log ---',
    log,
  ].join('\n')
  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ title: t('copied'), icon: 'none' }),
  })
}

/**
 * 复制一份带新时间戳的配对链接。
 *
 * 用途是做一次决定性的交叉验证：把这条链接粘进手机浏览器，如果官方页面能列出任务，
 * 说明链接是好的、问题在我们的客户端；如果官方页面同样停在等待，说明电脑端那一侧
 * 压根没上线（二维码已换版，或者远控页面没真正持有连接）。
 *
 * 代价必须先说清楚：官方页面与 shou 用的是**同一个 sid**，两边同时开会把对方踢掉。
 * 所以测完关掉浏览器页面，再回 shou 就会自己连回来。
 */
function copyLink() {
  const endpointValue = endpoint.value
  if (!endpointValue?.params?.sid) {
    uni.showToast({ title: t('notPairedYet'), icon: 'none' })
    return
  }
  uni.setClipboardData({
    data: buildPairingUrl(endpointValue),
    success: () => uni.showToast({ title: t('copied'), icon: 'none' }),
  })
}

function reconnect() {
  const endpointValue = endpoint.value
  if (!endpointValue) return
  disconnectEndpoint(endpointId.value)
  setTimeout(() => {
    connectEndpoint(endpointValue)
    refresh()
  }, 300)
}
</script>

<style scoped>
.shou-diag__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}

.shou-diag__label {
  flex: none;
}

.shou-diag__value {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--shou-text-hi);
  word-break: break-all;
}

.shou-diag__value--bad {
  color: var(--shou-danger);
}

.shou-diag__hint {
  line-height: 1.7;
  margin-bottom: 10px;
}

.shou-diag__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.shou-chip--btn {
  color: var(--shou-accent);
  border-color: var(--shou-accent);
}

.shou-diag__probe {
  margin-top: 10px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--shou-text-lo);
  word-break: break-all;
}

.shou-diag__logcard {
  max-height: 46vh;
  overflow: hidden;
}

.shou-diag__line {
  display: flex;
  gap: 6px;
  padding: 3px 0;
  border-bottom: 1px solid var(--shou-hairline);
}

.shou-diag__dir {
  flex: none;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.6;
}

.shou-diag__dir--out {
  color: var(--shou-accent);
}
.shou-diag__dir--in {
  color: var(--shou-live);
}
.shou-diag__dir--err {
  color: var(--shou-danger);
}
.shou-diag__dir--state {
  color: var(--shou-text-lo);
}

.shou-diag__text {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.6;
  color: var(--shou-text-hi);
  word-break: break-all;
}

.shou-diag__actions {
  display: flex;
  gap: 10px;
  margin: 16px;
}

.shou-diag__actions > view {
  flex: 1;
}
</style>
