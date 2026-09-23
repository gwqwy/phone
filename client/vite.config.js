// HBuilderX 项目：此文件会被 HBuilderX 内置 vite 合并（无需引入 uni 插件）
// 作用：开发运行时把 /api 与 /ws 代理到本机 zcode-phone 服务（默认 3930）
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3930', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3930', ws: true },
    },
  },
})
