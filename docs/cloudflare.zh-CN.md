# 单个 Cloudflare Worker 部署

[English](cloudflare.md) · [简体中文](cloudflare.zh-CN.md) · [返回 README](../README.zh-CN.md)

Worker 在同一次部署中提供 Vue 页面并处理 `/api/*`。它直接请求 X；无需 Node API、`API_ORIGIN`、`API_PROXY_SECRET`、数据库或 Worker KV 绑定。

## 部署前

默认的 `workers.dev` 页面是公开的。**输入 X Cookie 前，请先用 Cloudflare Access 或其他方式验证访问页面的用户。**浏览器将 X Cookie 和迁移状态保存在当前标签页的 `sessionStorage`。每次 API 请求将所需 Cookie 值发送给 Worker，Worker 只执行一个 X 操作或读取一页列表。关闭标签页会清除保存的会话。

## 部署

1. 安装 Node.js 24 和 pnpm，执行 `pnpm install --frozen-lockfile`。
2. 执行 `pnpm run cf:dry-run`，构建并检查 Worker 产物，不会发布。
3. 执行 `pnpm exec wrangler login` 登录，再执行 `pnpm run cf:deploy` 发布。
4. 使用真实 X 会话前，为 Worker 域名配置访客访问控制。

`wrangler.jsonc` 已指向 `worker/index.ts` 和 `dist` 静态资源目录。当前架构无需部署变量或密钥。

## 本地预览 Worker

执行 `pnpm run cf:dev`。Wrangler 会构建同一套 Vue 应用，并在本地启动相同的 API 路由；无需另启 Node API。

Worker 使用 Cloudflare 网络出口访问 X，不支持本地 HTTP 代理。Node 部署可按 README 使用 `X_MIGRATE_PROXY` 或常见代理环境变量。dry run 只检查打包，不验证 X 的可访问性，也不会操作真实账号。
