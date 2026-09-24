import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHTML } from 'linkedom'

const { window } = parseHTML('<html><body><div id="app"></div></body></html>')
Object.assign(globalThis, {
  window,
  document: window.document,
  Element: window.Element,
  SVGElement: window.SVGElement,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
})

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
globalThis.sessionStorage = storage()
globalThis.localStorage = storage()

const { createApp } = await import('vue')
const { i18n } = await import('../src/i18n.ts')
const { useMigration } = await import('../src/useMigration.ts')

function mount() {
  let migration
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      migration = useMigration()
      return () => null
    },
  })
  app.use(i18n)
  app.mount(element)
  return {
    migration,
    unmount: () => {
      app.unmount()
      element.remove()
    },
  }
}

const source = { id: '100', screenName: 'old', name: 'Old', avatarUrl: null, followingCount: 2 }
const target = { id: '200', screenName: 'new', name: 'New', avatarUrl: null, followingCount: 1 }
const first = {
  id: '301',
  label: 'First',
  detail: '@first',
  url: 'https://x.com/first',
  avatarUrl: null,
}
const second = {
  id: '302',
  label: 'Second',
  detail: '@second',
  url: 'https://x.com/second',
  avatarUrl: null,
}

test('browser flow resumes cleanup after a rate limit and page reload without copying again', async () => {
  const originalFetch = globalThis.fetch
  const actions = []
  let cleanupCalls = 0
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('/api/'))
    const body = JSON.parse(init.body)
    if (url === '/api/connect')
      return Response.json({ account: body.authToken === 'source-token' ? source : target })
    if (url === '/api/page') {
      assert.equal(body.kind, 'following')
      return Response.json({
        items: body.authToken === 'source-token' ? [first, second] : [second],
        cursor: null,
      })
    }
    if (url === '/api/action') {
      actions.push([body.authToken, body.action, body.id])
      if (body.action === 'unfollow' && ++cleanupCalls === 1)
        return Response.json(
          { error: 'Rate limited', retryAt: Date.now() + 60_000 },
          { status: 429 },
        )
      return Response.json({ ok: true })
    }
    assert.fail('Unexpected API path: ' + url)
  }

  let firstApp
  let restoredApp
  try {
    firstApp = mount()
    const state = firstApp.migration
    state.credentials.source.authToken = 'source-token'
    state.credentials.source.ct0 = 'source-csrf'
    state.credentials.target.authToken = 'target-token'
    state.credentials.target.ct0 = 'target-csrf'
    await state.connect('source')
    await state.connect('target')
    state.selected.bookmarks = false
    await state.scan()
    assert.equal(state.job.value.stage, 'ready')
    assert.equal(state.previewComplete.value, true)
    assert.deepEqual(state.job.value.summary.following, { source: 2, alreadyThere: 1, toCopy: 1 })
    state.toggleItem('following', '301')
    state.removeSource.following = true
    state.removeConfirmation.value = '@old'
    await state.begin()
    assert.equal(state.job.value.stage, 'paused')
    assert.equal(state.job.value.progress.copied, 1)
    const saved = JSON.parse(sessionStorage.getItem('x-migrate.browser.v3'))
    assert.equal(saved.plan.entries[0].phase, 'remove')
    firstApp.unmount()
    firstApp = null

    restoredApp = mount()
    assert.equal(restoredApp.migration.job.value.stage, 'paused')
    await restoredApp.migration.resume()
    assert.equal(restoredApp.migration.job.value.stage, 'completed')
    assert.equal(restoredApp.migration.job.value.progress.copied, 1)
    assert.equal(restoredApp.migration.job.value.progress.removed, 1)
    assert.deepEqual(actions, [
      ['target-token', 'follow', '301'],
      ['source-token', 'unfollow', '301'],
      ['source-token', 'unfollow', '301'],
    ])
  } finally {
    firstApp?.unmount()
    restoredApp?.unmount()
    globalThis.fetch = originalFetch
  }
})
