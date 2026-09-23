<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../api/client'

interface ModelOption {
  providerId: string
  modelId: string
  label?: string
  reasoningLevels?: string[]
  reasoningLevel?: string
  note?: string
}

const props = defineProps<{ visible: boolean; sessionId: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

const loading = ref(false)
const models = ref<ModelOption[]>([])
const current = ref<{ providerId: string; modelId: string; reasoningLevel?: string } | null>(null)
// 每个模型可单独设推理强度（默认 high）
const levels = ref<Record<string, string>>({})
const busyKey = ref('')
const error = ref('')

const keyOf = (m: ModelOption): string => `${m.providerId}/${m.modelId}`
const currentKey = computed(() => (current.value ? `${current.value.providerId}/${current.value.modelId}` : ''))

watch(
  () => props.visible,
  (v) => {
    if (v) void load()
  },
)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await api.request<{ models: ModelOption[]; current: { providerId: string; modelId: string; reasoningLevel?: string } | null }>(
      'models.list',
      { sessionId: props.sessionId },
    )
    models.value = res.models ?? []
    current.value = res.current ?? null
    const next: Record<string, string> = {}
    for (const m of models.value) next[keyOf(m)] = m.reasoningLevel ?? 'high'
    levels.value = next
  } catch (e) {
    error.value = String((e as Error).message ?? '模型列表加载失败')
  } finally {
    loading.value = false
  }
}

async function pick(m: ModelOption): Promise<void> {
  const k = keyOf(m)
  if (busyKey.value) return
  busyKey.value = k
  error.value = ''
  try {
    const reasoningLevel = m.reasoningLevels?.length ? levels.value[k] : undefined
    await api.request('model.set', {
      sessionId: props.sessionId,
      providerId: m.providerId,
      modelId: m.modelId,
      reasoningLevel,
    })
    current.value = { providerId: m.providerId, modelId: m.modelId, reasoningLevel }
    uni.showToast({ title: `已切换：${m.modelId}`, icon: 'none' })
    emit('changed')
    emit('close')
  } catch (e) {
    error.value = String((e as Error).message ?? '切换失败')
  } finally {
    busyKey.value = ''
  }
}

function cycleLevel(m: ModelOption): void {
  const list = m.reasoningLevels ?? []
  if (!list.length) return
  const k = keyOf(m)
  const idx = list.indexOf(levels.value[k] ?? list[0]!)
  levels.value = { ...levels.value, [k]: list[(idx + 1) % list.length]! }
}
</script>

<template>
  <view v-if="visible" class="mp-mask" @tap="emit('close')">
    <view class="mp-sheet" @tap.stop>
      <view class="mp-head">
        <text class="mp-title">选择模型</text>
        <text class="mp-close" @tap="emit('close')">✕</text>
      </view>
      <text v-if="current" class="mp-current">当前：{{ current.modelId }}{{ current.reasoningLevel ? ` · ${current.reasoningLevel}` : '' }}</text>

      <view v-if="loading" class="mp-empty"><text>加载中…</text></view>
      <view v-else-if="error" class="mp-empty mp-error"><text>{{ error }}</text></view>
      <view v-else-if="!models.length" class="mp-empty"><text>没有可用模型（可在 .data/config.json 配置 API Key）</text></view>

      <scroll-view v-else scroll-y class="mp-list">
        <view
          v-for="m in models"
          :key="keyOf(m)"
          class="mp-row"
          :class="{ active: keyOf(m) === currentKey, busy: busyKey === keyOf(m) }"
          @tap="pick(m)"
        >
          <view class="mp-row-main">
            <text class="mp-name">{{ m.modelId }}</text>
            <text class="mp-provider">{{ m.label || m.providerId }}<template v-if="m.note"> · {{ m.note }}</template></text>
          </view>
          <text v-if="m.reasoningLevels && m.reasoningLevels.length" class="mp-level" @tap.stop="cycleLevel(m)">
            {{ levels[keyOf(m)] || 'high' }}
          </text>
          <text v-if="keyOf(m) === currentKey" class="mp-check">✓</text>
          <text v-else-if="busyKey === keyOf(m)" class="mp-check">…</text>
        </view>
      </scroll-view>
      <text class="mp-hint">点右侧强度可切换推理等级（off/low/medium/high）</text>
    </view>
  </view>
</template>

<style scoped>
.mp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}
.mp-sheet {
  width: 100%;
  max-height: 76vh;
  background: var(--zp-bg-elev);
  border-radius: 16px 16px 0 0;
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mp-title {
  color: var(--zp-text);
  font-size: 16px;
  font-weight: 700;
}
.mp-close {
  color: var(--zp-text-dim);
  font-size: 15px;
  padding: 2px 6px;
}
.mp-current {
  display: block;
  margin-top: 6px;
  color: var(--zp-text-faint);
  font-size: 12px;
}
.mp-list {
  margin-top: 10px;
  max-height: 52vh;
  border: 1px solid var(--zp-border);
  border-radius: 10px;
}
.mp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--zp-border);
}
.mp-row:last-child {
  border-bottom: none;
}
.mp-row.active {
  background: var(--zp-bg-elev2);
}
.mp-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mp-name {
  color: var(--zp-text);
  font-size: 14px;
  font-weight: 600;
}
.mp-provider {
  color: var(--zp-text-faint);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-level {
  color: var(--zp-accent);
  font-size: 12px;
  border: 1px solid var(--zp-border);
  border-radius: 999px;
  padding: 3px 10px;
}
.mp-check {
  color: var(--zp-ok);
  font-weight: 700;
  font-size: 14px;
}
.mp-empty {
  padding: 26px 4px;
  text-align: center;
  color: var(--zp-text-faint);
  font-size: 13px;
}
.mp-error {
  color: var(--zp-err);
}
.mp-hint {
  margin-top: 8px;
  color: var(--zp-text-faint);
  font-size: 11px;
}
</style>
