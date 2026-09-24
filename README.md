<div align="center">

# X Migrate

**Move your follows and bookmarks between X accounts.**

Scan both accounts, review every item, and choose exactly what to transfer.

[English](README.md) · [简体中文](README.zh-CN.md)

<img src="docs/preview.png" alt="X Migrate account connection screen" width="900">

</div>

> [!IMPORTANT]
> This tool uses X web session cookies (`auth_token` and `ct0`). Treat them like passwords. Run the local version on a computer you trust. If you host the Worker version, protect the public site with access control before entering cookies.

## What it does

- Migrates follows, bookmarks, or both. It scans the complete selected lists on both accounts and skips items already on the destination.
- Shows a preview before any changes. Nothing is selected by default.
- Keeps the old account's items by default. Removing selected items from the old account requires entering its `@handle`; each item is removed only after it is present on the new account.
- Supports stopping a job and resuming after X rate limits. Completed X actions are not automatically rolled back.
- Detects Chinese or English from the browser on first visit. The language switch in the page overrides that choice and is remembered locally.

## Run locally

Requires **Node.js 24** and **pnpm**.

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

Open <http://127.0.0.1:5199/>. For a production Node deployment, run `pnpm run build && pnpm run start`; the page and API are served together on <http://127.0.0.1:5198/>. Set `X_MIGRATE_HOST` and `X_MIGRATE_PORT` to change that address. If Node runs behind an HTTPS reverse proxy, set `X_MIGRATE_ORIGIN` to its public origin, such as `https://migrate.example.com`, so browser API requests pass the origin check. `pnpm run preview` also works on the local Vite address.

## Transfer safely

1. Sign in to the old and new X accounts in separate browser profiles or sessions. For each account, copy an authenticated X request **as curl** from the browser's Network panel and paste it into the matching form. You can also copy the **values** of `auth_token` and `ct0` from Application → Cookies → `https://x.com`.
2. Connect both accounts. The curl input is cleared after parsing; the cookie fields are hidden after connection. The current tab keeps the cookie values, scan results, selections, and transfer progress in `sessionStorage` so it can resume after a refresh. Closing the tab clears that saved session.
3. Choose follows, bookmarks, or both, then scan. A failed scan cannot start a transfer. Check the counts and preview, especially if X returns an uncertain end of list.
4. Select the items to move. Existing destination items cannot be selected. If you also want to remove transferred items from the old account, select that option and type the old account's `@handle` to confirm.
5. Start the transfer. You can stop it. On HTTP 429, the job waits until the time provided by X, or 15 minutes when none is provided; you can also resume or stop it manually.

## How it works

```mermaid
flowchart LR
  Browser[Vue UI and sessionStorage] -->|same-origin /api| Node[Node or Vite]
  Browser -->|same-origin /api| Worker[Cloudflare Worker]
  Node --> Core[Shared Hono API and X client]
  Worker --> Core
  Core --> X[X web API]
```

Vite, the standalone Node server, and Cloudflare Worker use the same Hono routes and X client. Each API request performs one operation or list page. The browser holds the task state; no server session store is required. Local services listen on `127.0.0.1` by default.

For hosted deployment, see [Single Cloudflare Worker](docs/cloudflare.md). The default `workers.dev` page is publicly reachable until you add access control, such as Cloudflare Access. Protect the page before entering X cookies.

## Network and X API notes

- Node uses `X_MIGRATE_PROXY` when set, then `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and the Windows system proxy. Set `X_MIGRATE_PROXY=direct` to bypass other proxy settings. The Worker uses Cloudflare's network path and does not support a local HTTP proxy.
- Query IDs are discovered from current X web scripts. If discovery fails after X changes its web client, Advanced settings accepts the ID from a matching `/graphql/` request in X's Network panel. Retry after changing these settings.
- Scanning follows uses larger pages and spaces list requests for the same account by at least two seconds. X can still change response formats or rate limits. The tool stops on incomplete or unexpected lists rather than transferring a partial result.
- X's current bookmarks endpoint does not return a total count. The total becomes known after scanning. Some lists can end without an explicit marker; the page asks you to verify the count and preview in that case.

## Checks

```bash
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run cf:dry-run
```

Tests use simulated X clients and do not change real accounts. The Cloudflare dry run builds and checks deployment output without publishing it.

This is an independent community project and is not affiliated with X. It uses X's web API, which may change without notice.

## License

[MIT](LICENSE)
