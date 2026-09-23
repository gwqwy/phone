<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import NavBar from '../../components/NavBar.vue'
import TimelineRow from '../../components/TimelineRow.vue'
import SidePanel from '../../components/SidePanel.vue'
import ModelPicker from '../../components/ModelPicker.vue'
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
const modelPickerVisible = ref(false)
const currentModel = ref('')

/** 读取会话当前模型（用于导航栏展示） */
async function loadCurrentModel(): Promise<void> {
  try {
    const res = await api.request<{ current: { providerId: string; modelId: string } | null }>('models.list', {
      sessionId: sessionId.value,
    })
    currentModel.value = res.current?.modelId ?? ''
  } catch {
    currentModel.value = ''
  }
}

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
  void loadCurrentModel()
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

// 精简视图：按轮折叠——用户消息 + 折叠的执行过程 + 最终回复（像 ZCode 官方）
const compact = ref(true)
const expandedTurns = ref<Set<number>>(new Set())

interface TurnGroup {
  turn: number
  user?: TimelineEvent
  work: TimelineEvent[]
  texts: TimelineEvent[]
  approvals: TimelineEvent[]
  duration?: string
}

const turnGroups = computed<TurnGroup[]>(() => {
  const groups: TurnGroup[] = []
  let cur: TurnGroup | null = null
  const ensure = (): TurnGroup => {
    if (!cur) {
      cur = { turn: groups.length, work: [], texts: [], approvals: [] }
      groups.push(cur)
    }
    return cur
  }
  for (const ev of events.value) {
    if (ev.kind === 'user') {
      cur = { turn: groups.length, user: ev, work: [], texts: [], approvals: [] }
      groups.push(cur)
      continue
    }
    const g = ensure()
    if (ev.kind === 'approval') g.approvals.push(ev)
    else if (ev.kind === 'text') g.texts.push(ev)
    g.work.push(ev)
  }
  // 每轮只展示最后一条 AI 文本，其余进折叠区；折叠条标注工作时长
  for (const g of groups) {
    const lastText = g.texts[g.texts.length - 1]
    if (lastText) g.work = g.work.filter((e) => e.id !== lastText.id)
    const stamps = [g.user?.ts, ...g.work.map((e) => e.ts), ...g.texts.map((e) => e.ts)].filter(Boolean)
    if (stamps.length >= 2) {
      const ms = new Date(stamps[stamps.length - 1]!).getTime() - new Date(stamps[0]!).getTime()
      if (ms > 1000) {
        const s = Math.round(ms / 1000)
        g.duration = s >= 60 ? `已工作 ${Math.floor(s / 60)} 分 ${s % 60} 秒` : `已工作 ${s} 秒`
      }
    }
  }
  return groups
})

function toggleTurn(turn: number): void {
  const s = new Set(expandedTurns.value)
  if (s.has(turn)) s.delete(turn)
  else s.add(turn)
  expandedTurns.value = s
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || sending.value || !canSend.value) return
  sending.value = true
  try {
    await api.request('send', { sessionId: sessionId.value, text })
    input.value = ''
  } catch (e) {
    // 发送失败也要让用户看到自己说了什么，并给出具体原因
    const msg = String((e as Error).message ?? '发送失败')
    events.value.push({
      id: `local-${Date.now()}`,
      kind: 'user',
      ts: new Date().toISOString(),
      status: 'error',
      text,
    })
    void scrollToBottom()
    uni.showModal({ title: '发送失败', content: msg.slice(0, 200), showCancel: false })
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
        <text class="model-btn" @tap="modelPickerVisible = true">
          <text class="model-btn-icon">⚙</text>
          <text class="model-btn-text">{{ currentModel || '模型' }}</text>
        </text>
        <text class="panel-btn" :class="{ on: !compact }" @tap="compact = !compact">{{ compact ? '详' : '简' }}</text>
        <text v-if="running && canStop" class="stop-btn" @tap="stopTask">停止</text>
        <text class="panel-btn" @tap="panelVisible = true">▤</text>
      </template>
    </NavBar>

    <scroll-view class="timeline" scroll-y :scroll-into-view="scrollInto" scroll-with-animation>
      <view v-if="loading" class="placeholder"><text>加载中…</text></view>
      <view v-else-if="loadError" class="placeholder"><text>{{ loadError }}</text></view>
      <view v-else-if="!events.length" class="placeholder"><text>暂无消息</text></view>
      <view v-else-if="compact" class="timeline-inner">
        <view v-for="g in turnGroups" :key="g.turn">
          <TimelineRow v-if="g.user" :ev="g.user" />
          <TimelineRow
            v-for="a in g.approvals"
            :key="a.id"
            :ev="a"
            @resolve="(o) => resolve(a.id, o)"
          />
          <view v-if="g.work.length" class="turn-collapse" @tap="() => toggleTurn(g.turn)">
            <text class="turn-collapse-label">{{ expandedTurns.has(g.turn) ? '收起执行过程' : `执行过程 · ${g.work.length} 步${g.duration ? ' · ' + g.duration : ''}` }}</text>
          </view>
          <view v-if="expandedTurns.has(g.turn)">
            <TimelineRow v-for="ev in g.work" :key="ev.id" :ev="ev" />
          </view>
          <TimelineRow v-if="g.tailText" :ev="g.tailText" />
        </view>
        <view v-if="running" class="running-hint"><text>● 正在工作中…</text></view>
        <view class="timeline-pad" />
      </view>
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
    <ModelPicker
      :visible="modelPickerVisible"
      :session-id="sessionId"
      @close="modelPickerVisible = false"
      @changed="loadCurrentModel"
    />
  </view>
</template>

<style scoped>
.model-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--zp-bg-elev2);
  color: var(--zp-accent);
  font-size: 13px;
  font-weight: 600;
  padding: 6px 12px;
  border: 1px solid var(--zp-accent);
  border-radius: 999px;
  max-width: 190px;
  box-sizing: border-box;
}
.model-btn-icon {
  font-size: 13px;
}
.model-btn-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
.panel-btn {
  color: var(--zp-text-dim);
  font-size: 14px;
  padding: 4px 8px;
  border: 1px solid var(--zp-border);
  border-radius: 8px;
}
.panel-btn.on {
  color: var(--zp-accent);
  border-color: var(--zp-accent);
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
.turn-collapse {
  padding: 6px 10px;
  margin: 4px 0;
  background: var(--zp-bg-elev);
  border-radius: 8px;
  display: inline-block;
}
.turn-collapse-label {
  color: var(--zp-accent);
  font-size: 12px;
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
