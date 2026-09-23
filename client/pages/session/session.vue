<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import NavBar from '../../components/NavBar.vue'
import TimelineRow from '../../components/TimelineRow.vue'
import SidePanel from '../../components/SidePanel.vue'
import { api, conn, httpGet, ensureHttpBase } from '../../api/client'
import { index } from '../../store/app'
import { themeClass } from '../../theme/theme'
import type { TimelineEvent } from '../../api/types'

const sessionId = ref('')
const events = ref<TimelineEvent[]>([])
const loading = ref(true)
const loadError = ref('')
const input = ref('')
const sending = ref(false)
const scrollInto = ref('')
const panelVisible = ref(false)

const task = computed(() => index.tasks.find((t) => t.id === sessionId.value))
const title = computed(() => task.value?.alias || task.value?.title || '任务会话')
const activeAdapter = computed(() => conn.hello?.adapters[0] ?? null)
const canSend = computed(() => activeAdapter.value?.capabilities.sendText ?? false)
const canStop = computed(() => activeAdapter.value?.capabilities.stop ?? false)
const running = computed(() => task.value?.status === 'running')

let subOpen = false

onLoad((options) => {
  sessionId.value = typeof options?.id === 'string' ? options.id : ''
  if (!sessionId.value) {
    loadError.value = '缺少会话 ID'
    loading.value = false
    return
  }
  void (async () => {
    await ensureHttpBase()
    await checkAuth()
  })()
  subOpen = true
  api.subscribe('session', 'session-stream', { sessionId: sessionId.value }, (kind, data) => {
    if (!subOpen) return
    handleFrame(kind, data)
  })
  // 进入会话即清除未读标记
  void api.request('meta.set', { sessionId: sessionId.value, patch: { unread: false } }).catch(() => {})
})

async function checkAuth(): Promise<void> {
  try {
    const res = await httpGet<{ ok: boolean }>('/api/bootstrap')
    if (res.statusCode === 401) {
      api.close()
      uni.reLaunch({ url: '/pages/login/login' })
    }
  } catch {
    // 网络抖动不处理
  }
}

onUnload(() => {
  subOpen = false
  api.unsubscribe('session')
})

function handleFrame(kind: string, data: unknown): void {
  if (!data || typeof data !== 'object') return
  const d = data as { sessionId?: string; events?: TimelineEvent[]; error?: unknown }
  if (d.sessionId && d.sessionId !== sessionId.value) return
  if (kind === 'snapshot') {
    events.value = d.events ?? []
    loading.value = false
    void scrollToBottom()
    return
  }
  if (kind === 'end') {
    loadError.value = String(d.error ?? '流已结束')
    loading.value = false
    return
  }
  const incoming = d.events ?? []
  if (!incoming.length) return
  // 按 id 合并（update 语义），新事件追加
  const idx = new Map(events.value.map((e, i) => [e.id, i]))
  for (const ev of incoming) {
    const at = idx.get(ev.id)
    if (at !== undefined) events.value[at] = ev
    else {
      idx.set(ev.id, events.value.length)
      events.value.push(ev)
    }
  }
  void scrollToBottom()
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const last = events.value[events.value.length - 1]
  if (last) scrollInto.value = `ev-${last.id}`
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || sending.value || !canSend.value) return
  sending.value = true
  try {
    await api.request('send', { sessionId: sessionId.value, text })
    input.value = ''
  } catch (e) {
    uni.showToast({ title: String((e as Error).message ?? '发送失败').slice(0, 30), icon: 'none' })
  } finally {
    sending.value = false
  }
}

async function stopTask(): Promise<void> {
  try {
    await api.request('stop', { sessionId: sessionId.value })
    uni.showToast({ title: '已发送停止指令', icon: 'none' })
  } catch (e) {
    uni.showToast({ title: String((e as Error).message ?? '停止失败').slice(0, 30), icon: 'none' })
  }
}

async function resolve(interactionId: string, outcome: 'approve' | 'reject'): Promise<void> {
  try {
    await api.request('resolve', { sessionId: sessionId.value, interactionId, outcome })
  } catch (e) {
    uni.showToast({ title: String((e as Error).message ?? '操作失败').slice(0, 30), icon: 'none' })
  }
}
</script>

<template>
  <view class="zp-page" :class="themeClass">
    <NavBar :title="title" :back="true" @back="() => uni.navigateBack()">
      <template #right>
        <text v-if="running && canStop" class="stop-btn" @tap="stopTask">停止</text>
        <text class="panel-btn" @tap="panelVisible = true">▤</text>
      </template>
    </NavBar>

    <scroll-view class="timeline" scroll-y :scroll-into-view="scrollInto" scroll-with-animation>
      <view v-if="loading" class="placeholder"><text>加载中…</text></view>
      <view v-else-if="loadError" class="placeholder"><text>{{ loadError }}</text></view>
      <view v-else-if="!events.length" class="placeholder"><text>暂无消息</text></view>
      <view v-else class="timeline-inner">
        <view v-for="ev in events" :id="`ev-${ev.id}`" :key="ev.id">
          <TimelineRow :ev="ev" @resolve="(o) => resolve(ev.id, o)" />
        </view>
        <view v-if="running" class="running-hint"><text>● 正在工作中…</text></view>
        <view class="timeline-pad" />
      </view>
    </scroll-view>

    <view class="composer">
      <input
        v-model="input"
        class="composer-input"
        :disabled="!canSend"
        :placeholder="canSend ? '提出后续修改要求' : '该 harness 暂不支持远程发送'"
        placeholder-class="composer-ph"
        confirm-type="send"
        :confirm-disabled="sending"
        @confirm="send"
      />
      <view class="composer-send" :class="{ active: input.trim() && canSend && !sending }" @tap="send">
        <text>↑</text>
      </view>
    </view>
    <SidePanel :visible="panelVisible" :session-id="sessionId" @close="panelVisible = false" />
  </view>
</template>

<style scoped>
.panel-btn {
  color: var(--zp-text-dim);
  font-size: 18px;
  padding: 4px 8px;
}
.stop-btn {
  color: var(--zp-err);
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--zp-err);
  border-radius: 8px;
}
.timeline {
  height: calc(100vh - 48px - 58px);
}
.timeline-inner {
  padding: 10px 14px 0;
}
.timeline-pad {
  height: 20px;
}
.placeholder {
  margin-top: 80px;
  text-align: center;
  color: var(--zp-text-faint);
  font-size: 13px;
}
.running-hint {
  margin-top: 8px;
  color: var(--zp-accent);
  font-size: 12px;
}
.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  background: var(--zp-bg);
  border-top: 1px solid var(--zp-border);
}
.composer-input {
  flex: 1;
  height: 40px;
  background: var(--zp-bg-elev2);
  border: 1px solid var(--zp-border);
  border-radius: 20px;
  padding: 0 14px;
  color: var(--zp-text);
  font-size: 14px;
}
.composer-ph {
  color: var(--zp-text-faint);
}
.composer-send {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--zp-bg-elev2);
  color: var(--zp-text-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
}
.composer-send.active {
  background: var(--zp-accent);
  color: #fff;
}
</style>
