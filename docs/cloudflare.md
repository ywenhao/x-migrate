# Cloudflare Worker + Node API

本地运行仍用 `pnpm run dev`，网络代理留空时继续自动检测环境变量和 Windows 系统代理。CF Worker 使用原生 `fetch` 提供页面并转发 `/api`，不启用 `HTTP_PROXY`。X 请求、会话和迁移任务继续由独立 Node 服务处理。

## 配置

1. 在一台持续运行的 Node.js 24 主机上执行 `pnpm install --frozen-lockfile` 和 `pnpm run api`。API 默认监听 `127.0.0.1:5198`，需要用 HTTPS 反向代理提供独立地址，例如 `https://api.example.com`。Node 服务设置 `X_MIGRATE_PROXY_SECRET`，值为至少 32 字符的随机字符串。
2. 有了 Node API 地址后，在 `wrangler.jsonc` 中加入 `"vars": { "API_ORIGIN": "https://你的-Node-API-地址" }`。在项目目录执行 `pnpm exec wrangler login`、`pnpm exec wrangler secret put API_PROXY_SECRET`，输入与 Node 相同的字符串，最后执行 `pnpm run cf:deploy`。Worker 使用 Cloudflare 默认的 `workers.dev` 地址。

Node 与 Worker 之间只需要这个共享密钥；没有浏览器登录密码。`API_ORIGIN` 是 Node 服务地址，不是 `HTTP_PROXY`，属于普通地址配置，无需 `secret put`。Node API 校验共享密钥；Worker 拒绝跨站来源的 API 请求。未填地址或密钥时，API 返回 503。

本地调试可先运行 Node API，再在不提交的 `.dev.vars` 中填入 `API_ORIGIN=http://127.0.0.1:5198` 和 `API_PROXY_SECRET`，运行 `pnpm run cf:dev`。`pnpm run cf:dry-run` 只检查打包，不发布。

页面在默认 `workers.dev` 域名上公开可访问；需要限制谁能打开页面时，可另行配置 Cloudflare Access。Node 进程重启后，内存中的 X 会话和迁移任务需要重新创建。
