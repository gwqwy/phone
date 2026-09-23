<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../api/client'
import type { TaskSummary, Workspace } from '../api/types'

const props = defineProps<{ visible: boolean; workspaces: Workspace[]; tasks?: TaskSummary[] }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'created', sessionId: string): void }>()

const selectedWs = ref('')
const text = ref('')
const busy = ref(false)
const error = ref('')

/** 常用工作区排前面（按最近任务时间），默认选中最近使用的一个 */
const sortedWs = computed(() => {
  const lastAt = new Map<string, string>()
  for (const t of props.tasks ?? []) {
    const cur = lastAt.get(t.workspaceId)
    if (!cur || t.updatedAt > cur) lastAt.set(t.workspaceId, t.updatedAt)
  }
  return [...props.workspaces].sort((a, b) => (lastAt.get(b.id) ?? '').localeCompare(lastAt.get(a.id) ?? ''))
})

watch(
  () => props.visible,
  (v) => {
    if (v) {
      if (!selectedWs.value && sortedWs.value.length) selectedWs.value = sortedWs.value[0]!.id
      error.value = ''
    }
  },
)

const canSubmit = computed(() => !!selectedWs.value && !!text.value.trim() && !busy.value)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await api.request<{ sessionId: string }>('create', {
      workspaceId: selectedWs.value,
      text: text.value.trim(),
    })
    text.value = ''
    emit('close')
    emit('created', res.sessionId)
  } catch (e) {
    error.value = String((e as Error).message ?? '创建失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <view v-if="visible" class="ct-mask" @tap="emit('close')">
    <view class="ct-sheet" @tap.stop>
      <text class="ct-title">新建任务</text>
      <text class="ct-label">选择工作区</text>
      <scroll-view scroll-y class="ct-ws-list">
        <view
          v-for="w in sortedWs"
          :key="w.id"
          class="ct-ws-row"
          :class="{ active: selectedWs === w.id }"
          @tap="selectedWs = w.id"
        >
          <text class="ct-ws-name">{{ w.name }}</text>
          <text class="ct-ws-path">{{ w.path }}</text>
          <text v-if="selectedWs === w.id" class="ct-check">✓</text>
        </view>
      </scroll-view>
      <text class="ct-label">任务内容</text>
      <textarea
        v-model="text"
        class="ct-input"
        :maxlength="2000"
        placeholder="描述要让电脑执行的任务…"
        placeholder-class="ct-ph"
        :auto-height="true"
        :disabled="busy"
      />
      <text v-if="error" class="ct-error">{{ error }}</text>
      <button class="ct-submit" :disabled="!canSubmit" @tap="submit">
        {{ busy ? '创建中…' : '创建并开始' }}
      </button>
    </view>
  </view>
</template>

<style scoped>
.ct-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}
.ct-sheet {
  width: 100%;
  background: var(--zp-bg-elev);
  border-radius: 16px 16px 0 0;
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
}
.ct-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--zp-text);
  margin-bottom: 12px;
}
.ct-label {
  font-size: 12px;
  color: var(--zp-text-dim);
  margin: 6px 0;
}
.ct-ws-list {
  max-height: 180px;
  border: 1px solid var(--zp-border);
  border-radius: 10px;
  margin-bottom: 10px;
}
.ct-ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--zp-border);
}
.ct-ws-row:last-child {
  border-bottom: none;
}
.ct-ws-row.active {
  background: var(--zp-bg-elev2);
}
.ct-ws-name {
  color: var(--zp-text);
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.ct-ws-path {
  flex: 1;
  color: var(--zp-text-faint);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ct-check {
  color: var(--zp-ok);
  font-weight: 700;
}
.ct-input {
  width: 100%;
  min-height: 72px;
  background: var(--zp-bg-elev2);
  border: 1px solid var(--zp-border);
  border-radius: 10px;
  padding: 10px 12px;
  color: var(--zp-text);
  font-size: 14px;
  box-sizing: border-box;
  line-height: 1.5;
}
.ct-ph {
  color: var(--zp-text-faint);
}
.ct-error {
  color: var(--zp-err);
  font-size: 12px;
  margin-top: 8px;
}
.ct-submit {
  margin-top: 12px;
  height: 44px;
  line-height: 44px;
  border-radius: 10px;
  background: var(--zp-accent);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  padding: 0;
}
.ct-submit[disabled] {
  opacity: 0.5;
}
</style>
