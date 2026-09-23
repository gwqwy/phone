<script setup lang="ts">
import { computed } from 'vue'
import type { TaskSummary } from '../api/types'

const props = defineProps<{ visible: boolean; task: TaskSummary | null; workspacePath?: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'action', action: string): void }>()

const items = computed(() => {
  const t = props.task
  if (!t) return []
  const list: { key: string; label: string }[] = [
    { key: 'pin', label: t.pinned ? '取消置顶' : '置顶任务' },
    { key: 'rename', label: '重命名任务' },
    { key: 'archive', label: t.archived ? '取消归档' : '归档任务' },
    { key: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },
  ]
  if (props.workspacePath) list.push({ key: 'copyPath', label: '复制工作区路径' })
  list.push({ key: 'copyId', label: '复制会话 ID' })
  return list
})

function tap(key: string): void {
  emit('action', key)
  emit('close')
}
</script>

<template>
  <view v-if="visible && task" class="tcm-mask" @tap="emit('close')">
    <view class="tcm-menu" @tap.stop>
      <view v-for="it in items" :key="it.key" class="tcm-row" @tap="() => tap(it.key)">
        <text class="tcm-label">{{ it.label }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.tcm-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 110;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
}
.tcm-menu {
  margin: 90px 0 0 78px;
  min-width: 190px;
  background: var(--zp-bg-elev2);
  border: 1px solid var(--zp-border);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.tcm-row {
  padding: 12px 16px;
  border-radius: 8px;
}
.tcm-row:active {
  background: var(--zp-bg-elev);
}
.tcm-label {
  color: var(--zp-text);
  font-size: 14px;
}
</style>
