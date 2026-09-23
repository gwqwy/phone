<script setup lang="ts">
import { computed, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import NavBar from '../../components/NavBar.vue'
import ThemePicker from '../../components/ThemePicker.vue'
import { api, conn, httpGet } from '../../api/client'
import { applyIndex, index } from '../../store/app'
import { themeClass } from '../../theme/theme'
import type { TaskSummary } from '../../api/types'

const pickerVisible = ref(false)

let authTimer: ReturnType<typeof setInterval> | null = null

onLoad(() => {
  void checkAuth()
  api.connect()
  api.subscribe('index', 'sessions-index', undefined, (kind, data) => applyIndex(kind, data))
  // 服务端重启会使 cookie 失效（sessionKey 轮换），定时探测并回登录页
  authTimer = setInterval(() => void checkAuth(), 30_000)
})

onUnload(() => {
  api.unsubscribe('index')
  if (authTimer) clearInterval(authTimer)
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

const activeAdapter = computed(() => conn.hello?.adapters[0] ?? null)
const counts = computed(() => `${index.workspaces.length} 个工作区 · ${index.tasks.length} 个任务`)
const activeTasks = computed(() => index.tasks.filter((t) => !t.archived))

const ws = computed(() => index.workspaces.map((w) => ({ ...w, tasks: index.tasks.filter((t) => t.workspaceId === w.id) })))

const statusText: Record<string, string> = {
  running: '进行中',
  completed: '已完成',
  'waiting-approval': '待确认',
  error: '出错',
  idle: '空闲',
  unknown: '—',
}

function openTask(t: TaskSummary): void {
  uni.navigateTo({ url: `/pages/session/session?id=${encodeURIComponent(t.id)}` })
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 时`
  return `${Math.floor(h / 24)} 天`
}
</script>

<template>
  <view class="zp-page" :class="themeClass">
    <NavBar title="ZCode 远程控制">
      <template #right>
        <text class="icon-btn" @tap="pickerVisible = true">🎨</text>
      </template>
    </NavBar>

    <view class="body">
      <view class="info-card">
        <text class="info-main">
          {{ conn.connected ? '已连接到桌面服务' : conn.retryCount > 0 ? '重连中…' : '正在连接桌面服务…' }}
        </text>
        <text class="info-sub">
          适配器：{{ activeAdapter ? `${activeAdapter.label} · ${activeAdapter.ready ? '已就绪' : '未就绪'}` : '—' }}
        </text>
      </view>

      <view class="section-head">
        <text class="section-title">当前设备上的工作区和任务</text>
        <text class="section-count">{{ counts }}</text>
      </view>

      <view v-if="!index.ready" class="placeholder">
        <text>{{ index.loaded ? '适配器未就绪，等待 M1 接入 ZCode' : '加载中…' }}</text>
      </view>

      <view v-else>
        <view v-for="w in ws" :key="w.id" class="ws-card">
          <view class="ws-head">
            <text class="ws-icon">📂</text>
            <text class="ws-name">{{ w.name }}</text>
            <text class="ws-path">{{ w.path }}</text>
            <text class="ws-count">{{ w.tasks.length }} 个任务</text>
          </view>
          <view
            v-for="t in w.tasks"
            :key="t.id"
            class="task-row"
            @tap="() => openTask(t)"
          >
            <text class="task-name">{{ t.alias || t.title || '未命名任务' }}</text>
            <view class="task-meta">
              <text class="task-time">{{ relativeTime(t.updatedAt) }}</text>
              <text class="task-status" :class="`st-${t.status}`">{{ statusText[t.status] ?? '—' }}</text>
            </view>
          </view>
          <view v-if="!w.tasks.length" class="ws-empty"><text>暂无任务</text></view>
        </view>
        <view v-if="!activeTasks.length" class="placeholder">
          <text>暂无任务</text>
        </view>
      </view>
    </view>

    <ThemePicker :visible="pickerVisible" @close="pickerVisible = false" />
  </view>
</template>

<style scoped>
.icon-btn {
  font-size: 20px;
  padding: 4px 8px;
}
.body {
  padding: 12px 14px 40px;
}
.info-card {
  background: var(--zp-bg-elev);
  border: 1px solid var(--zp-border);
  border-radius: 12px;
  padding: 14px 16px;
}
.info-main {
  display: block;
  font-size: 14px;
  color: var(--zp-text);
}
.info-sub {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--zp-text-dim);
}
.section-head {
  margin: 18px 2px 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--zp-text);
}
.section-count {
  font-size: 12px;
  color: var(--zp-text-faint);
}
.placeholder {
  margin-top: 40px;
  text-align: center;
  color: var(--zp-text-faint);
  font-size: 13px;
}
.ws-card {
  background: var(--zp-bg-elev);
  border: 1px solid var(--zp-border);
  border-radius: 12px;
  margin-bottom: 12px;
  overflow: hidden;
}
.ws-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--zp-border);
}
.ws-icon {
  font-size: 15px;
}
.ws-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--zp-text);
}
.ws-path {
  flex: 1;
  font-size: 11px;
  color: var(--zp-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ws-count {
  font-size: 11px;
  color: var(--zp-text-dim);
}
.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 14px;
  border-bottom: 1px solid var(--zp-border);
}
.task-row:last-child {
  border-bottom: none;
}
.task-name {
  font-size: 14px;
  color: var(--zp-text);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: 10px;
}
.task-time {
  font-size: 11px;
  color: var(--zp-text-faint);
}
.task-status {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
}
.st-completed {
  color: var(--zp-ok);
  background: var(--zp-ok-bg);
}
.st-running {
  color: var(--zp-accent);
  background: rgba(76, 141, 255, 0.14);
}
.st-waiting-approval {
  color: var(--zp-warn);
  background: rgba(232, 179, 57, 0.14);
}
.st-error {
  color: var(--zp-err);
  background: rgba(229, 83, 75, 0.14);
}
.st-idle,
.st-unknown {
  color: var(--zp-text-dim);
  background: var(--zp-bg-elev2);
}
.ws-empty {
  padding: 14px;
  color: var(--zp-text-faint);
  font-size: 12px;
  text-align: center;
}
</style>
