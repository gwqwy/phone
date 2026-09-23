import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

export default defineConfig({
  plugins: [uni()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // 开发期把 API/WS 代理到本机 server（生产由 server 直接托管构建产物）
      '/api': { target: 'http://127.0.0.1:3930', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3930', ws: true },
    },
  },
})
