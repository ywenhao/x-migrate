import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import worker from '../worker/index.ts'
import { xApiNodeHandler } from '../server/plugin.ts'

const proxySecret = 'proxy-secret-1234567890-1234567890'
const workerOrigin = 'https://x-migrate.example.workers.dev'

function workerEnv() {
  return {
    API_ORIGIN: 'https://api.example.com',
    API_PROXY_SECRET: proxySecret,
    ASSETS: { fetch: async () => new Response('asset served') },
  }
}

test('Worker 提供静态页面并在同一个 Worker 内处理 API', async () => {
  const env = { ASSETS: { fetch: async () => new Response('asset served') } }
  const asset = await worker.fetch(new Request(`${workerOrigin}/`), env)
  assert.equal(await asset.text(), 'asset served')

  const crossSite = await worker.fetch(
    new Request(`${workerOrigin}/api/health`, {
      headers: { origin: 'https://other.example.com', 'accept-language': 'en-US' },
    }),
    env,
  )
  assert.equal(crossSite.status, 403)
  assert.match((await crossSite.json()).error, /other sites/)

  const health = await worker.fetch(new Request(`${workerOrigin}/api/health`, { headers: { origin: workerOrigin } }), env)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
})
test('独立 Node API 只接受共享密钥', async () => {
  const previousSecret = process.env.X_MIGRATE_PROXY_SECRET
  process.env.X_MIGRATE_PROXY_SECRET = proxySecret
  const server = createServer(xApiNodeHandler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const denied = await fetch(`${base}/api/health`, { headers: { origin: workerOrigin } })
    assert.equal(denied.status, 403)
    const wrong = await fetch(`${base}/api/health`, {
      headers: { 'x-x-migrate-proxy-key': 'wrong-key', 'accept-language': 'en-US' },
    })
    assert.equal(wrong.status, 403)
    assert.match((await wrong.json()).error, /Proxy authentication failed/)
    const allowed = await fetch(`${base}/api/health`, {
      headers: { origin: workerOrigin, 'x-x-migrate-proxy-key': proxySecret },
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { ok: true })
    const oversized = await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { 'x-x-migrate-proxy-key': proxySecret },
      body: 'x'.repeat(2 * 1024 * 1024 + 1),
    })
    assert.equal(oversized.status, 413)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previousSecret === undefined) delete process.env.X_MIGRATE_PROXY_SECRET
    else process.env.X_MIGRATE_PROXY_SECRET = previousSecret
  }
})
