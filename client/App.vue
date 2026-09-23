<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'
import { initTheme } from './theme/theme'

onLaunch(() => {
  initTheme()
})
</script>

<style>
@import './theme/theme.css';

page {
  background-color: var(--zp-bg);
  color: var(--zp-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 15px;
}
</style>
