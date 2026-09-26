<script>
import { state, initApp, applyNativeChrome, lockEnabled } from './store/app.js'
import { connectEndpoint, resumeConnections } from './api/session-manager.js'
import { applyKeepAlive } from './api/keepalive.js'
import { closeAll } from './api/dsh-panel.js'
import { ENDPOINT_KIND_RELAY } from './core/pairing-link.js'

// App.vue 用选项式写法而不是 <script setup>：应用级生命周期（onLaunch/onShow/onHide）
// 在选项式里支持得最稳，而这里只有三个钩子，写法差异可以忽略。
export default {
  onLaunch() {
    initApp()
    // 冷启动就把已导入的 ZCode 端点接上：用户打开 App 就是想看状态，
    // 让他再点一次才连接是没有意义的等待。
    for (const endpoint of state.list) {
      if (endpoint.kind === ENDPOINT_KIND_RELAY) connectEndpoint(endpoint)
    }
  },

  onShow() {
    applyNativeChrome()
    applyKeepAlive()
    // 回前台立即恢复没有连上的端点：waiting 的重试计时器可能还剩十几秒，
    // 用户既然回来了就没必要让他等完。
    resumeConnections()
    if (lockEnabled() && !state.unlocked) {
      const pages = getCurrentPages()
      const current = pages.length ? pages[pages.length - 1].route : ''
      if (current !== 'pages/lock/lock') {
        uni.navigateTo({ url: '/pages/lock/lock' })
      }
    }
  },

  onHide() {
    // 息屏或切后台时把 dsh 面板收起来：WebView 常驻是为了切换快，
    // 但后台留着它们只会让系统更想冻结我们。
    closeAll()
  },
}
</script>

<style>
@import './theme/theme.css';

page {
  background-color: #0b1016;
  color: #e6eef4;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
</style>
