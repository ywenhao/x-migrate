# Cloudflare Worker + Node API

此部署方式由 Hono Worker 提供静态页面、访问密码和同源 `/api` 转发；X 请求、会话与迁移任务仍在 Node 服务中执行。`wrangler.jsonc` 使用 Cloudflare 默认的 `workers.dev` 地址。Worker 需要一个**独立的 HTTPS Node API 地址**，不能把自己的 `workers.dev` 地址填为 `API_ORIGIN`。

## 1. 准备 Node API

在持续运行的 Node.js 24 主机上安装依赖，并将独立 HTTPS 地址（例如 `https://api.example.com`）反向代理到本机 `127.0.0.1:5198`。Node 服务默认只监听回环地址；生产环境由同机的 HTTPS 反向代理接收外部请求。

设置以下环境变量后执行 `pnpm run api`：

| 变量 | 值 |
| --- | --- |
| `X_MIGRATE_PROXY_SECRET` | 随机生成的至少 32 字符密钥，须与 Worker 的 `API_PROXY_SECRET` 相同 |
| `X_MIGRATE_APP_ORIGIN` | Worker 对外页面来源，例如 `https://x-migrate.<subdomain>.workers.dev` |
| `X_MIGRATE_API_HOST` | 可选，默认 `127.0.0.1` |
| `X_MIGRATE_API_PORT` | 可选，默认 `5198` |

在 PowerShell 中可生成密钥：

```powershell
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

该密钥只放在 Node 服务的环境变量和 Cloudflare Secret 中，不要提交到仓库。Node API 会校验共享密钥与页面来源；直接请求 API 会被拒绝。迁移任务和 X Cookie 仍只在 Node 进程内，重启 Node 后需要重新连接账号。

Worker 使用原生 `fetch` 转发，不启用 `HTTP_PROXY`。X 请求在 Node 主机发出；该主机要直连 X 时，在页面的网络代理栏填写 `direct`。

## 2. 部署 Worker

在项目目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run cf:deploy
```

第一次部署会得到 `https://x-migrate.<subdomain>.workers.dev`。将这个完整来源设为 Node 的 `X_MIGRATE_APP_ORIGIN`，然后在 Cloudflare 设置 Worker Secret：

```powershell
pnpm exec wrangler secret put APP_USERNAME
pnpm exec wrangler secret put APP_PASSWORD
pnpm exec wrangler secret put API_ORIGIN
pnpm exec wrangler secret put API_PROXY_SECRET
```

`APP_PASSWORD` 至少 16 字符；浏览器访问页面时会弹出原生账号密码窗口。`API_ORIGIN` 填 Node API 的 HTTPS 根地址，`API_PROXY_SECRET` 填与 Node 相同的密钥。所有四项均配置后，打开 Worker 地址即可使用。配置缺失时 Worker 返回 503，不会把未保护的 API 暴露出去。

可先用 `pnpm run cf:dry-run` 检查 Worker 打包。`pnpm run cf:dev` 会构建页面并启动本地 Worker；本地调试可在未提交的 `.dev.vars` 中设置上述四项，并让 Node 的 `X_MIGRATE_APP_ORIGIN` 指向本地 Worker 地址。
