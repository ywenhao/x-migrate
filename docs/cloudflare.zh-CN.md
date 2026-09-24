# Cloudflare Worker + Node API

[English](cloudflare.md) · [简体中文](cloudflare.zh-CN.md) · [返回 README](../README.zh-CN.md)

Worker 提供构建后的页面，并将 `/api/*` 转发给独立的 Node 进程。X 请求、Cookie 会话和迁移任务都保存在 Node 内存中。Worker 使用原生 `fetch`，不使用 `HTTP_PROXY`。

## 部署前

默认的 `workers.dev` 页面是公开的。**输入 X Cookie 前，请先使用 Cloudflare Access 或其他方式验证访问页面的用户。**下面的共享密钥只用于 Worker 到 Node 的通信，不能限制谁使用网页。Node API 应通过 HTTPS 提供，并始终校验共享密钥。

## 配置 Node

1. 在持续运行的主机上安装 Node.js 24，并执行 `pnpm install --frozen-lockfile`。
2. 将 `X_MIGRATE_PROXY_SECRET` 设置为至少 32 字符的随机字符串，不要提交到仓库。可选设置 `X_MIGRATE_API_HOST` 和 `X_MIGRATE_API_PORT`，默认分别为 `127.0.0.1` 和 `5198`。
3. 执行 `pnpm run api`，再用 HTTPS 反向代理提供 API 地址，例如 `https://api.example.com`。

## 配置 Worker

1. 在 `wrangler.jsonc` 中加入 `"vars": { "API_ORIGIN": "https://api.example.com" }`，地址替换为你的 Node API。`API_ORIGIN` 是普通地址配置，不是网络代理或密钥。
2. 执行 `pnpm exec wrangler login`，再执行 `pnpm exec wrangler secret put API_PROXY_SECRET`，输入与 `X_MIGRATE_PROXY_SECRET` 相同的值。
3. 先执行 `pnpm run cf:dry-run` 检查打包，再执行 `pnpm run cf:deploy` 发布。
4. 使用真实 X 会话前，为 Worker 域名配置访客访问控制。

缺少地址或密钥时，Worker API 返回 503。Node 校验共享密钥；Worker 拒绝带有其他站点 `Origin` 的 API 请求。

## 本地预览 Worker

先启动 Node API，再在不提交的 `.dev.vars` 中填写以下配置，然后运行 `pnpm run cf:dev`：

```dotenv
API_ORIGIN=http://127.0.0.1:5198
API_PROXY_SECRET=replace-with-the-same-local-secret
```

`pnpm run cf:dry-run` 只检查打包，不会部署。Node 重启后，内存中的会话和任务会清空，用户需要重新连接并扫描。
