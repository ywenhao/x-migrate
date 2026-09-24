import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { xApiPlugin } from './server/plugin.ts'

// https://vitejs.dev
export default defineConfig({
  plugins: [
    // Vue 3.6 Vapor 模式：SFC 内使用 <script setup vapor> 即自动启用
    vue(),
    // 本地 API 中间件（开发 + 预览都挂载 /api），负责代理请求 X 内部接口
    xApiPlugin(),
  ],
  server: {
    port: 5199,
    host: '127.0.0.1',
  },
  preview: {
    port: 5199,
    host: '127.0.0.1',
  },
})
