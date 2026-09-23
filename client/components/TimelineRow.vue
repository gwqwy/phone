<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TimelineEvent } from '../api/types'

const props = defineProps<{ ev: TimelineEvent }>()
const emit = defineEmits<{ (e: 'resolve', outcome: 'approve' | 'reject'): void }>()

const expanded = ref(false)

const fileBase = computed(() => {
  const f = props.ev.meta?.file as string | undefined
  if (!f) return ''
  const idx = Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'))
  return idx >= 0 ? f.slice(idx + 1) : f
})

const toolLabel = computed(() => {
  const t = props.ev.meta?.tool as string | undefined
  return t ?? ''
})

const thinkDuration = computed(() => {
  const d = props.ev.meta?.durationSec as number | undefined
  if (d === undefined) return ''
  return d < 60 ? `持续了 ${Math.max(1, Math.round(d))} 秒` : `持续了 ${Math.round(d / 60)} 分钟`
})

const statusIcon = computed(() => {
  switch (props.ev.status) {
    case 'running':
      return '⏳'
    case 'error':
      return '✖'
    case 'pending':
      return '…'
    default:
      return ''
  }
})

const timeLabel = computed(() => {
  const d = new Date(props.ev.ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
</script>

<template>
  <!-- 用户消息 -->
  <view v-if="ev.kind === 'user'" class="row row-user">
    <view class="user-bubble">
      <text class="user-text">{{ ev.text }}</text>
    </view>
  </view>

  <!-- AI 正文 -->
  <view v-else-if="ev.kind === 'text'" class="row">
    <text class="assistant-text" :user-select="true">{{ ev.text }}</text>
  </view>

  <!-- 思考 -->
  <view v-else-if="ev.kind === 'think'" class="row" @tap="expanded = !expanded">
    <view class="chip-row">
      <text class="chip-icon">🧠</text>
      <text class="chip-label">思考</text>
      <text v-if="thinkDuration" class="chip-dim">· {{ thinkDuration }}</text>
      <text v-if="ev.status === 'running'" class="chip-dim">· 进行中</text>
      <text class="chip-expand">{{ expanded ? '收起' : '展开' }}</text>
    </view>
    <text v-if="expanded" class="think-text" :user-select="true">{{ ev.text }}</text>
  </view>

  <!-- 编辑 -->
  <view v-else-if="ev.kind === 'edit'" class="row" @tap="expanded = !expanded">
    <view class="chip-row">
      <text class="chip-icon">✏️</text>
      <text class="chip-label">编辑</text>
      <text class="chip-dim">{{ fileBase || ev.text }}</text>
      <text v-if="ev.meta?.added !== undefined" class="diff-add">+{{ ev.meta.added }}</text>
      <text v-if="ev.meta?.removed !== undefined" class="diff-del">-{{ ev.meta.removed }}</text>
      <text class="chip-status">{{ statusIcon }}</text>
    </view>
    <text v-if="expanded && fileBase !== ev.text" class="mono-text">{{ ev.text }}</text>
  </view>

  <!-- 终端 -->
  <view v-else-if="ev.kind === 'terminal'" class="row" @tap="expanded = !expanded">
    <view class="chip-row">
      <text class="chip-icon">🖥</text>
      <text class="chip-label">终端</text>
      <text class="mono-dim">{{ ev.text?.slice(0, expanded ? 2000 : 64) }}</text>
      <text v-if="!expanded && (ev.text?.length ?? 0) > 64" class="chip-expand">…</text>
      <text class="chip-status">{{ statusIcon }}</text>
    </view>
    <text v-if="expanded" class="mono-text" :user-select="true">{{ ev.text }}</text>
  </view>

  <!-- 其他工具 -->
  <view v-else-if="ev.kind === 'tool'" class="row">
    <view class="chip-row">
      <text class="chip-icon">🔧</text>
      <text class="chip-label">{{ toolLabel || '工具' }}</text>
      <text v-if="ev.text && ev.text !== toolLabel" class="chip-dim">{{ ev.text.slice(0, 72) }}</text>
      <text class="chip-status">{{ statusIcon }}</text>
    </view>
  </view>

  <!-- 审批 -->
  <view v-else-if="ev.kind === 'approval'" class="row">
    <view class="approval-card">
      <text class="approval-title">{{ ev.text }}</text>
      <text v-if="ev.meta?.input" class="approval-input">{{ String(ev.meta.input).slice(0, 200) }}</text>
      <view v-if="ev.status === 'pending'" class="approval-actions">
        <button class="btn-approve" @tap="emit('resolve', 'approve')">批准</button>
        <button class="btn-reject" @tap="emit('resolve', 'reject')">拒绝</button>
      </view>
      <text v-else class="approval-done">{{ ev.text }}</text>
    </view>
  </view>

  <!-- 补丁 / 系统 -->
  <view v-else-if="ev.kind === 'patch'" class="row">
    <view class="chip-row">
      <text class="chip-icon">📦</text>
      <text class="chip-label">{{ ev.text }}</text>
    </view>
  </view>
  <view v-else class="row">
    <text class="system-text">{{ ev.text }}</text>
  </view>
</template>

<style scoped>
.row {
  padding: 5px 0;
}
.row-user {
  display: flex;
  justify-content: flex-end;
}
.user-bubble {
  max-width: 86%;
  background: var(--zp-user-bubble);
  border-radius: 12px 12px 4px 12px;
  padding: 9px 12px;
}
.user-text {
  color: var(--zp-text);
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
}
.assistant-text {
  color: var(--zp-text);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}
.chip-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  padding: 3px 0;
}
.chip-icon {
  font-size: 12px;
}
.chip-label {
  color: var(--zp-text-dim);
  font-size: 12px;
  font-weight: 600;
}
.chip-dim {
  color: var(--zp-text-faint);
  font-size: 12px;
  max-width: 420px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chip-status {
  color: var(--zp-text-faint);
  font-size: 11px;
}
.chip-expand {
  color: var(--zp-accent);
  font-size: 11px;
}
.think-text {
  color: var(--zp-text-faint);
  font-size: 12px;
  line-height: 1.5;
  background: var(--zp-bg-elev);
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 4px;
  word-break: break-word;
}
.mono-dim {
  color: var(--zp-text-faint);
  font-size: 11px;
  font-family: Consolas, Menlo, monospace;
}
.mono-text {
  color: var(--zp-text-dim);
  font-size: 11px;
  font-family: Consolas, Menlo, monospace;
  background: var(--zp-bg-elev);
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 4px;
  word-break: break-all;
  line-height: 1.5;
}
.diff-add {
  color: var(--zp-ok);
  font-size: 12px;
  font-family: Consolas, Menlo, monospace;
}
.diff-del {
  color: var(--zp-err);
  font-size: 12px;
  font-family: Consolas, Menlo, monospace;
}
.approval-card {
  background: var(--zp-bg-elev);
  border: 1px solid var(--zp-warn);
  border-radius: 12px;
  padding: 12px;
  margin: 6px 0;
}
.approval-title {
  color: var(--zp-text);
  font-size: 13px;
  font-weight: 600;
}
.approval-input {
  display: block;
  color: var(--zp-text-faint);
  font-size: 11px;
  font-family: Consolas, Menlo, monospace;
  margin-top: 6px;
  word-break: break-all;
}
.approval-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.btn-approve {
  flex: 1;
  height: 36px;
  line-height: 36px;
  font-size: 14px;
  background: var(--zp-ok);
  color: #fff;
  border-radius: 8px;
  padding: 0;
  margin: 0;
}
.btn-reject {
  flex: 1;
  height: 36px;
  line-height: 36px;
  font-size: 14px;
  background: var(--zp-bg-elev2);
  color: var(--zp-err);
  border-radius: 8px;
  padding: 0;
  margin: 0;
}
.approval-done {
  color: var(--zp-text-faint);
  font-size: 12px;
  margin-top: 6px;
}
.system-text {
  color: var(--zp-text-faint);
  font-size: 11px;
}
</style>
