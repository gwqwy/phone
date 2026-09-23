import { computed, reactive } from 'vue'

export type ThemeMode = 'system' | 'dark' | 'light'

const STORAGE_KEY = 'zp_theme'

export const theme = reactive({
  mode: 'system' as ThemeMode,
  resolved: 'dark' as 'dark' | 'light',
})

export const themeClass = computed(() => `theme-${theme.resolved}`)

export const themeLabel = computed(() =>
  theme.mode === 'system' ? '系统默认' : theme.mode === 'dark' ? '深色主题' : '浅色主题',
)

function systemDark(): boolean {
  try {
    const si = uni.getSystemInfoSync()
    if (typeof si.theme === 'string') return si.theme === 'dark'
  } catch {
    // 取不到系统主题时按深色
  }
  // #ifdef H5
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  // #endif
  return true
}

function resolve(): void {
  theme.resolved = theme.mode === 'system' ? (systemDark() ? 'dark' : 'light') : theme.mode
}

export function initTheme(): void {
  try {
    const saved = uni.getStorageSync(STORAGE_KEY) as string
    if (saved === 'dark' || saved === 'light' || saved === 'system') theme.mode = saved
  } catch {
    // 存储不可用则用默认
  }
  resolve()
  // #ifdef H5
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme.mode === 'system') resolve()
  })
  // #endif
}

export function setThemeMode(mode: ThemeMode): void {
  theme.mode = mode
  resolve()
  try {
    uni.setStorageSync(STORAGE_KEY, mode)
  } catch {
    // 存储不可用仅本次生效
  }
}
