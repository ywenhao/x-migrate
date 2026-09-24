import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { xApiPlugin } from './server/plugin.ts'

// https://vitejs.dev
export default defineConfig({
  plugins: [
    // Vue 3.6 Vapor 模式：SFC 内使用 <script setup vapor> 即自动启用
    vue(),
    // 本地开发和预览使用与 Worker 相同的 Hono API 路由。
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
