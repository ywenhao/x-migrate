import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import worker from '../worker/index.ts'
import { xApiNodeHandler } from '../server/plugin.ts'

const password = 'worker-password-1234567890'
const proxySecret = 'proxy-secret-1234567890-1234567890'
const workerOrigin = 'https://x-migrate.example.workers.dev'
const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`

function workerEnv() {
  return {
    APP_USERNAME: 'admin',
    APP_PASSWORD: password,
    API_ORIGIN: 'https://api.example.com',
    API_PROXY_SECRET: proxySecret,
    ASSETS: { fetch: async () => new Response('asset served') },
  }
}

test('Worker 保护静态页面，并转发已认证的 API 请求', async () => {
  const env = workerEnv()
  const denied = await worker.fetch(new Request(`${workerOrigin}/`), env)
  assert.equal(denied.status, 401)
  const asset = await worker.fetch(new Request(`${workerOrigin}/`, {
    headers: { authorization },
  }), env)
  assert.equal(await asset.text(), 'asset served')

  const originalFetch = globalThis.fetch
  let upstream
  globalThis.fetch = async (request) => {
    upstream = request
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await worker.fetch(new Request(`${workerOrigin}/api/health?check=1`, {
      method: 'POST',
      headers: { authorization, origin: workerOrigin, 'content-type': 'application/json' },
      body: '{"check":true}',
    }), env)
    assert.equal(response.status, 200)
    assert.equal(upstream.url, 'https://api.example.com/api/health?check=1')
    assert.equal(upstream.headers.get('x-x-migrate-proxy-key'), proxySecret)
    assert.equal(upstream.headers.get('authorization'), null)
    assert.equal(upstream.headers.get('origin'), workerOrigin)
    assert.equal(upstream.redirect, 'manual')
    assert.equal(await upstream.text(), '{"check":true}')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('独立 Node API 只接受共享密钥和指定页面来源', async () => {
  const previousSecret = process.env.X_MIGRATE_PROXY_SECRET
  const previousOrigin = process.env.X_MIGRATE_APP_ORIGIN
  process.env.X_MIGRATE_PROXY_SECRET = proxySecret
  process.env.X_MIGRATE_APP_ORIGIN = workerOrigin
  const server = createServer(xApiNodeHandler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const denied = await fetch(`${base}/api/health`, { headers: { origin: workerOrigin } })
    assert.equal(denied.status, 403)
    const foreign = await fetch(`${base}/api/health`, {
      headers: { origin: 'https://other.example.com', 'x-x-migrate-proxy-key': proxySecret },
    })
    assert.equal(foreign.status, 403)
    const allowed = await fetch(`${base}/api/health`, {
      headers: { origin: workerOrigin, 'x-x-migrate-proxy-key': proxySecret },
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { ok: true })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previousSecret === undefined) delete process.env.X_MIGRATE_PROXY_SECRET
    else process.env.X_MIGRATE_PROXY_SECRET = previousSecret
    if (previousOrigin === undefined) delete process.env.X_MIGRATE_APP_ORIGIN
    else process.env.X_MIGRATE_APP_ORIGIN = previousOrigin
  }
})
