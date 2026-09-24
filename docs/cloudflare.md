# Cloudflare Worker + Node API

[English](cloudflare.md) · [简体中文](cloudflare.zh-CN.md) · [Back to README](../README.md)

The Worker serves the built page and forwards `/api/*` to a separate Node process. X requests, cookie sessions, and migration jobs stay in Node memory. The Worker uses native `fetch`; it does not use `HTTP_PROXY`.

## Before deploying

The default `workers.dev` page is public. **Protect it with Cloudflare Access or another visitor authentication layer before entering X cookies.** The shared secret below authenticates Worker-to-Node requests only. It does not restrict who can use the web page. Keep the Node API behind HTTPS and do not expose it without the shared secret.

## Configure Node

1. On a host that stays online, install Node.js 24 and run `pnpm install --frozen-lockfile`.
2. Set `X_MIGRATE_PROXY_SECRET` to a random string of at least 32 characters. Do not commit it. Optionally set `X_MIGRATE_API_HOST` and `X_MIGRATE_API_PORT`; defaults are `127.0.0.1` and `5198`.
3. Run `pnpm run api`. Put an HTTPS reverse proxy in front of the API, for example `https://api.example.com`.

## Configure Worker

1. Add `"vars": { "API_ORIGIN": "https://api.example.com" }` to `wrangler.jsonc`, using your Node API address. `API_ORIGIN` is a normal address configuration, not a proxy URL or a secret.
2. Run `pnpm exec wrangler login`, then `pnpm exec wrangler secret put API_PROXY_SECRET`. Enter the same value as `X_MIGRATE_PROXY_SECRET`.
3. Run `pnpm run cf:dry-run` to check the bundle, then `pnpm run cf:deploy` to publish.
4. Configure visitor access for the Worker hostname before using real X sessions.

Without the origin or secret, the Worker API returns 503. Node validates the shared secret, and the Worker rejects API requests with a foreign `Origin`.

## Local Worker preview

Start the Node API first. Put the following values in an untracked `.dev.vars` file, then run `pnpm run cf:dev`:

```dotenv
API_ORIGIN=http://127.0.0.1:5198
API_PROXY_SECRET=replace-with-the-same-local-secret
```

`pnpm run cf:dry-run` checks packaging without deploying. Restarting Node clears all sessions and jobs; users then need to reconnect and scan again.
