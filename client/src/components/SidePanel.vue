<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '../api/client'

const props = defineProps<{ visible: boolean; sessionId: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tab = ref<'review' | 'terminal'>('review')
const loading = ref(false)
const additions = ref(0)
const deletions = ref(0)
const files = ref<string[]>([])

watch(
  () => props.visible,
  (v) => {
    if (v && tab.value === 'review') void loadReview()
  },
)

async function switchTab(t: 'review' | 'terminal'): Promise<void> {
  tab.value = t
  if (t === 'review') await loadReview()
}

async function loadReview(): Promise<void> {
  if (!props.sessionId || loading.value) return
  loading.value = true
  try {
    const res = await api.request<{ additions: number; deletions: number; files: string[] }>('review', {
      sessionId: props.sessionId,
    })
    additions.value = res.additions ?? 0
    deletions.value = res.deletions ?? 0
    files.value = res.files ?? []
  } catch {
    additions.value = 0
    deletions.value = 0
    files.value = []
  } finally {
    loading.value = false
  }
}

function fileBase(f: string): string {
  const idx = Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'))
  return idx >= 0 ? f.slice(idx + 1) : f
}
</script>

<template>
  <view v-if="visible" class="sp-mask" @tap="emit('close')">
    <view class="sp-panel" @tap.stop>
      <view class="sp-tabs">
        <text class="sp-tab" :class="{ active: tab === 'review' }" @tap="() => switchTab('review')">审查</text>
        <text class="sp-tab" :class="{ active: tab === 'terminal' }" @tap="() => switchTab('terminal')">终端</text>
        <text class="sp-close" @tap="emit('close')">✕</text>
      </view>

      <scroll-view scroll-y class="sp-body">
        <template v-if="tab === 'review'">
          <view v-if="loading" class="sp-empty"><text>加载中…</text></view>
          <view v-else-if="!files.length && !additions && !deletions" class="sp-empty">
            <text>该会话还没有代码变更</text>
          </view>
          <template v-else>
            <view class="sp-summary">
              <text class="diff-add">+{{ additions }}</text>
              <text class="diff-del">-{{ deletions }}</text>
              <text class="sp-files-count">{{ files.length }} 个文件</text>
            </view>
            <view v-for="f in files" :key="f" class="sp-file-row">
              <text class="sp-file-icon">📄</text>
              <text class="sp-file-name">{{ fileBase(f) }}</text>
            </view>
          </template>
        </template>
        <view v-else class="sp-empty"><text>交互式终端即将上线</text></view>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped>
.sp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 90;
}
.sp-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 86%;
  background: var(--zp-bg);
  border-left: 1px solid var(--zp-border);
  display: flex;
  flex-direction: column;
}
.sp-tabs {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--zp-border);
}
.sp-tab {
  color: var(--zp-text-dim);
  font-size: 14px;
  padding: 4px 2px;
}
.sp-tab.active {
  color: var(--zp-text);
  font-weight: 700;
  border-bottom: 2px solid var(--zp-accent);
}
.sp-close {
  margin-left: auto;
  color: var(--zp-text-dim);
  font-size: 15px;
  padding: 2px 6px;
}
.sp-body {
  flex: 1;
  padding: 12px 14px;
  box-sizing: border-box;
}
.sp-empty {
  margin-top: 60px;
  text-align: center;
  color: var(--zp-text-faint);
  font-size: 13px;
}
.sp-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px 12px;
}
.diff-add {
  color: var(--zp-ok);
  font-family: Consolas, Menlo, monospace;
  font-size: 14px;
}
.diff-del {
  color: var(--zp-err);
  font-family: Consolas, Menlo, monospace;
  font-size: 14px;
}
.sp-files-count {
  color: var(--zp-text-faint);
  font-size: 12px;
}
.sp-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--zp-border);
}
.sp-file-icon {
  font-size: 13px;
}
.sp-file-name {
  color: var(--zp-text);
  font-size: 13px;
  word-break: break-all;
}
</style>
