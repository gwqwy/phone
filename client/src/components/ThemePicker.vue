<script setup lang="ts">
import { theme, themeLabel, setThemeMode, type ThemeMode } from '../theme/theme'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const options: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '系统默认' },
  { mode: 'dark', label: '深色主题' },
  { mode: 'light', label: '浅色主题' },
]
</script>

<template>
  <view v-if="visible" class="tp-mask" @tap="emit('close')">
    <view class="tp-sheet" :class="themeClass" @tap.stop>
      <view
        v-for="opt in options"
        :key="opt.mode"
        class="tp-row"
        @tap="() => { setThemeMode(opt.mode); emit('close') }"
      >
        <text class="tp-label">{{ opt.label }}</text>
        <text v-if="theme.mode === opt.mode" class="tp-check">✓</text>
      </view>
      <view class="tp-current"><text>当前：{{ themeLabel }}</text></view>
    </view>
  </view>
</template>

<style scoped>
.tp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}
.tp-sheet {
  width: 100%;
  background: var(--zp-bg-elev);
  border-radius: 14px 14px 0 0;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
}
.tp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
}
.tp-label {
  color: var(--zp-text);
  font-size: 15px;
}
.tp-check {
  color: var(--zp-ok);
  font-weight: 700;
}
.tp-current {
  border-top: 1px solid var(--zp-border);
  margin-top: 4px;
  padding: 10px 20px;
  color: var(--zp-text-faint);
  font-size: 12px;
}
</style>
