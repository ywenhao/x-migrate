import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import worker from '../worker/index.ts'
import { createApi } from '../shared/api.ts'
import { XApiError } from '../shared/x-api.ts'
import { xApiNodeHandler } from '../server/plugin.ts'

const origin = 'https://x-migrate.example.workers.dev'
const credentials = { authToken: 'source-token', ct0: 'source-csrf' }
const env = { ASSETS: { fetch: async () => new Response('asset served') } }

function request(path, body, headers = {}) {
  return new Request(origin + '/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...credentials, ...body }),
  })
}

test('Worker serves assets and shared API without a Node origin or secret', async () => {
  const asset = await worker.fetch(new Request(origin + '/'), env)
  assert.equal(await asset.text(), 'asset served')
  const health = await worker.fetch(new Request(origin + '/api/health'), env)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
  assert.equal(health.headers.get('cache-control'), 'no-store')

  const crossSite = await worker.fetch(
    new Request(origin + '/api/health', {
      headers: { origin: 'https://other.example.com', 'accept-language': 'en-US' },
    }),
    env,
  )
  assert.equal(crossSite.status, 403)
  assert.match((await crossSite.json()).error, /other sites/)
  assert.equal(crossSite.headers.get('cache-control'), 'no-store')

  const invalid = await worker.fetch(request('/action', { action: 'follow', id: 'bad' }), env)
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).error, /操作无效/)
  const oversized = await worker.fetch(
    new Request(origin + '/api/connect', {
      method: 'POST',
      body: 'x'.repeat(2 * 1024 * 1024 + 1),
    }),
    env,
  )
  assert.equal(oversized.status, 413)
  const unknown = await worker.fetch(new Request(origin + '/api/missing'), env)
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: '接口不存在。' })
})

test('Worker action uses the portable X client and passes session cookies only to X', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async function (url, init) {
    assert.equal(this, globalThis)
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/home')) return new Response('', { status: 404 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const response = await worker.fetch(request('/action', { action: 'follow', id: '301' }), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    const action = calls.find((call) => call.url.endsWith('/friendships/create.json'))
    assert.ok(action)
    assert.match(action.init.headers.cookie, /auth_token=source-token; ct0=source-csrf/)
    assert.ok(calls.every((call) => call.url.startsWith('https://x.com/')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Worker reads a following page through the shared X client', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/home')) return new Response('', { status: 404 })
    assert.match(String(url), /\/graphql\/following123\/Following/)
    return Response.json({
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        content: {
                          itemContent: {
                            user_results: {
                              result: {
                                rest_id: '301',
                                core: { screen_name: 'first', name: 'First' },
                              },
                            },
                          },
                        },
                      },
                      { content: { cursorType: 'Bottom', value: 'next-page' } },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    })
  }
  try {
    const response = await worker.fetch(
      request('/page', {
        kind: 'following',
        userId: '100',
        cursor: null,
        queryIds: { Following: 'following123' },
      }),
      env,
    )
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.items[0].id, '301')
    assert.equal(data.cursor, 'next-page')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shared API handles connect, page, action, rate limit, and closes each client', async () => {
  const calls = []
  let closes = 0
  const account = { id: '100', screenName: 'old', name: 'Old', avatarUrl: null, followingCount: 1 }
  const item = {
    id: '301',
    label: 'First',
    detail: '@first',
    url: 'https://x.com/first',
    avatarUrl: null,
  }
  const app = createApi(async (authToken, ct0, queryIds) => {
    calls.push(['create', authToken, ct0, queryIds])
    return {
      verify: async () => account,
      page: async (kind, userId, cursor) => {
        calls.push(['page', kind, userId, cursor])
        return { items: [item], cursor: null }
      },
      follow: async (id) => {
        calls.push(['follow', id])
      },
      unfollow: async () => {
        throw new XApiError('限流', 429, 1234567890000, 'Rate limited')
      },
      addBookmark: async () => {},
      removeBookmark: async () => {},
      close: async () => {
        closes++
      },
    }
  })
  const connect = await app.request(request('/connect', { queryIds: { Viewer: 'viewerid12' } }))
  assert.equal(connect.status, 200)
  assert.deepEqual(await connect.json(), { account })
  const page = await app.request(
    request('/page', { kind: 'following', userId: '100', cursor: null }),
  )
  assert.equal(page.status, 200)
  assert.deepEqual(await page.json(), { items: [item], cursor: null })
  const action = await app.request(request('/action', { action: 'follow', id: '301' }))
  assert.equal(action.status, 200)
  const limited = await app.request(
    request(
      '/action',
      { action: 'unfollow', id: '301' },
      {
        'accept-language': 'en-US',
      },
    ),
  )
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), { error: 'Rate limited', retryAt: 1234567890000 })
  assert.equal(closes, 4)
  assert.deepEqual(calls[0], ['create', 'source-token', 'source-csrf', { Viewer: 'viewerid12' }])
  assert.deepEqual(calls[2], ['page', 'following', '100', null])
})

test('Node request listener exposes the same health and validation rules', async () => {
  const server = createServer(xApiNodeHandler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const health = await fetch(base + '/api/health')
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
    const invalid = await fetch(base + '/api/page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, kind: 'following', userId: 'oops' }),
    })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /账号 ID 无效/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('an explicit public origin supports Node behind HTTPS reverse proxies', async () => {
  const app = createApi(undefined, 'https://migrate.example.com')
  const allowed = await app.request(
    new Request('http://127.0.0.1:5198/api/health', {
      headers: { origin: 'https://migrate.example.com' },
    }),
  )
  assert.equal(allowed.status, 200)
  const denied = await app.request(
    new Request('http://127.0.0.1:5198/api/health', {
      headers: { origin: 'https://other.example.com' },
    }),
  )
  assert.equal(denied.status, 403)
})
