# Single Cloudflare Worker

[English](cloudflare.md) · [简体中文](cloudflare.zh-CN.md) · [Back to README](../README.md)

The Worker serves the Vue build and handles `/api/*` in the same deployment. It calls X directly; no Node API, `API_ORIGIN`, `API_PROXY_SECRET`, database, or Worker KV binding is required.

## Before deploying

The default `workers.dev` page is public. **Protect the site with Cloudflare Access or another visitor authentication layer before entering X cookies.** The browser keeps the X cookies and migration state in this tab's `sessionStorage`. Each API request sends the relevant cookie values to the Worker, which uses them for one X operation or list page. Closing the tab clears the saved session.

## Deploy

1. Install Node.js 24 and pnpm, then run `pnpm install --frozen-lockfile`.
2. Run `pnpm run cf:dry-run` to build and check the Worker bundle without publishing.
3. Sign in with `pnpm exec wrangler login`, then run `pnpm run cf:deploy`.
4. Configure visitor access for the Worker hostname before using real X sessions.

`wrangler.jsonc` points to `worker/index.ts`, builds the Vue app before deployment, and serves the `dist` asset directory. No deployment variables or secrets are needed for this architecture.

## Local Worker preview

Run `pnpm run cf:dev`. Wrangler builds the Vue app and starts the same API routes locally. A separate Node API is not needed.

The Worker uses Cloudflare's network path to reach X and does not support a local HTTP proxy. Node deployments can use `X_MIGRATE_PROXY` or standard proxy environment variables, as described in the README. The dry run checks packaging; it does not verify access to X or perform account actions.
