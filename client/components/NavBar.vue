<script setup lang="ts">
defineProps<{ title: string; back?: boolean }>()
const emit = defineEmits<{ (e: 'back'): void }>()
</script>

<template>
  <view class="zp-nav">
    <view class="zp-nav-side" @tap="emit('back')">
      <text v-if="back" class="zp-nav-back">‹</text>
      <slot name="left" />
    </view>
    <text class="zp-nav-title">{{ title }}</text>
    <view class="zp-nav-side zp-nav-right">
      <slot name="right" />
    </view>
  </view>
</template>

<style scoped>
.zp-nav {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 10px;
  background: var(--zp-bg);
  position: sticky;
  top: 0;
  z-index: 10;
}
.zp-nav-side {
  min-width: 56px;
  display: flex;
  align-items: center;
}
.zp-nav-back {
  font-size: 30px;
  line-height: 1;
  color: var(--zp-text);
  padding: 0 8px;
}
.zp-nav-title {
  flex: 1;
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  color: var(--zp-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zp-nav-right {
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}
</style>
