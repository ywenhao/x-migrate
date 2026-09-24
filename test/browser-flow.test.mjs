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
  globalThis.sessionStorage = storage()
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

test('scans both accounts concurrently while keeping each account sequential', async () => {
  globalThis.sessionStorage = storage()
  const originalFetch = globalThis.fetch
  const bookmark = {
    id: '401',
    label: 'Saved post',
    detail: '@writer',
    url: 'https://x.com/i/web/status/401',
    avatarUrl: null,
  }
  let releaseSourceFollowing = () => {}
  const sourceFollowingHeld = new Promise((resolve) => {
    releaseSourceFollowing = resolve
  })
  let targetBookmarksStarted = () => {}
  const targetBookmarks = new Promise((resolve) => {
    targetBookmarksStarted = resolve
  })
  const active = { source: 0, target: 0 }
  const maxByRole = { source: 0, target: 0 }
  let maxTotal = 0
  const events = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const role = body.authToken === 'source-token' ? 'source' : 'target'
    if (url === '/api/connect')
      return Response.json({ account: role === 'source' ? source : target })
    assert.equal(url, '/api/page')
    active[role]++
    maxByRole[role] = Math.max(maxByRole[role], active[role])
    maxTotal = Math.max(maxTotal, active.source + active.target)
    events.push('start ' + role + ' ' + body.kind)
    try {
      if (role === 'source' && body.kind === 'following') await sourceFollowingHeld
      if (role === 'target' && body.kind === 'bookmarks') targetBookmarksStarted()
      const items =
        body.kind === 'following'
          ? role === 'source'
            ? [first, second]
            : [second]
          : role === 'source'
            ? [bookmark]
            : []
      return Response.json({ items, cursor: null })
    } finally {
      events.push('end ' + role + ' ' + body.kind)
      active[role]--
    }
  }

  let app
  let scanPromise
  try {
    app = mount()
    const state = app.migration
    state.credentials.source.authToken = 'source-token'
    state.credentials.source.ct0 = 'source-csrf'
    state.credentials.target.authToken = 'target-token'
    state.credentials.target.ct0 = 'target-csrf'
    await state.connect('source')
    await state.connect('target')
    scanPromise = state.scan()
    let timeout
    await Promise.race([
      targetBookmarks,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Target bookmarks did not start')), 1000)
      }),
    ]).finally(() => clearTimeout(timeout))
    assert.equal(active.source, 1)
    assert.equal(maxTotal, 2)
    assert.deepEqual(maxByRole, { source: 1, target: 1 })
    releaseSourceFollowing()
    await scanPromise
    assert.equal(state.job.value.stage, 'ready')
    assert.deepEqual(state.job.value.summary.following, { source: 2, alreadyThere: 1, toCopy: 1 })
    assert.deepEqual(state.job.value.summary.bookmarks, { source: 1, alreadyThere: 0, toCopy: 1 })
    assert.ok(events.indexOf('start target bookmarks') < events.indexOf('end source following'))
  } finally {
    releaseSourceFollowing()
    await scanPromise
    app?.unmount()
    globalThis.fetch = originalFetch
  }
})

test('completed partial transfer allows another batch without selecting copied items', async () => {
  globalThis.sessionStorage = storage()
  const originalFetch = globalThis.fetch
  const third = {
    id: '303',
    label: 'Third',
    detail: '@third',
    url: 'https://x.com/third',
    avatarUrl: null,
  }
  const sourceAccount = { ...source, followingCount: 3 }
  const targetAccount = { ...target, followingCount: 0 }
  const actions = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === '/api/connect')
      return Response.json({
        account: body.authToken === 'source-token' ? sourceAccount : targetAccount,
      })
    if (url === '/api/page')
      return Response.json({
        items: body.authToken === 'source-token' ? [first, second, third] : [],
        cursor: null,
      })
    assert.equal(url, '/api/action')
    actions.push([body.action, body.id])
    return Response.json({ ok: true })
  }

  let app
  try {
    app = mount()
    const state = app.migration
    state.credentials.source.authToken = 'source-token'
    state.credentials.source.ct0 = 'source-csrf'
    state.credentials.target.authToken = 'target-token'
    state.credentials.target.ct0 = 'target-csrf'
    await state.connect('source')
    await state.connect('target')
    state.selected.bookmarks = false
    await state.scan()
    assert.equal(state.job.value.stage, 'ready')
    state.toggleItem('following', '301')
    await state.begin()
    assert.equal(state.job.value.stage, 'completed')
    assert.equal(state.canChooseItems.value, true)
    assert.equal(state.remainingCount.value, 2)
    assert.equal(state.chosenCount.value, 0)
    assert.equal(state.previewItems.following.find((item) => item.id === '301').alreadyThere, true)
    assert.deepEqual(state.job.value.summary.following, { source: 3, alreadyThere: 1, toCopy: 2 })

    const saved = JSON.parse(sessionStorage.getItem('x-migrate.browser.v3'))
    saved.chosenIds.following = ['301']
    saved.job.summary.following = { source: 3, alreadyThere: 0, toCopy: 3 }
    sessionStorage.setItem('x-migrate.browser.v3', JSON.stringify(saved))
    app.unmount()
    app = mount()
    const restored = app.migration
    assert.equal(restored.job.value.stage, 'completed')
    assert.equal(restored.chosenCount.value, 0)
    assert.deepEqual(restored.job.value.summary.following, {
      source: 3,
      alreadyThere: 1,
      toCopy: 2,
    })
    restored.toggleItem('following', '301')
    assert.equal(restored.chosenCount.value, 0)
    restored.toggleItem('following', '302')
    await restored.begin()
    assert.equal(restored.job.value.stage, 'completed')
    assert.equal(restored.remainingCount.value, 1)
    assert.equal(restored.chosenCount.value, 0)
    assert.deepEqual(restored.job.value.summary.following, {
      source: 3,
      alreadyThere: 2,
      toCopy: 1,
    })
    assert.deepEqual(actions, [
      ['follow', '301'],
      ['follow', '302'],
    ])
  } finally {
    app?.unmount()
    globalThis.fetch = originalFetch
  }
})

test('refresh buttons replace one list only after both accounts succeed', async () => {
  globalThis.sessionStorage = storage()
  const originalFetch = globalThis.fetch
  const third = {
    id: '303',
    label: 'Third',
    detail: '@third',
    url: 'https://x.com/third',
    avatarUrl: null,
  }
  const savedPost = {
    id: '401',
    label: 'Saved',
    detail: '@writer',
    url: 'https://x.com/i/web/status/401',
    avatarUrl: null,
  }
  const nextPost = {
    id: '402',
    label: 'Next',
    detail: '@writer',
    url: 'https://x.com/i/web/status/402',
    avatarUrl: null,
  }
  let followingSource = [first, second]
  let followingTarget = [second]
  let bookmarksSource = [savedPost]
  let bookmarksTarget = []
  let failFollowing = false
  const pageCalls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const role = body.authToken === 'source-token' ? 'source' : 'target'
    if (url === '/api/connect')
      return Response.json({ account: role === 'source' ? source : target })
    if (url === '/api/action') return Response.json({ ok: true })
    assert.equal(url, '/api/page')
    pageCalls.push([role, body.kind])
    if (failFollowing && role === 'target' && body.kind === 'following')
      return Response.json({ error: 'Target list unavailable' }, { status: 502 })
    const items =
      body.kind === 'following'
        ? role === 'source'
          ? followingSource
          : followingTarget
        : role === 'source'
          ? bookmarksSource
          : bookmarksTarget
    return Response.json({ items, cursor: null })
  }

  let app
  try {
    app = mount()
    const state = app.migration
    state.credentials.source.authToken = 'source-token'
    state.credentials.source.ct0 = 'source-csrf'
    state.credentials.target.authToken = 'target-token'
    state.credentials.target.ct0 = 'target-csrf'
    await state.connect('source')
    await state.connect('target')
    await state.scan()
    assert.equal(state.job.value.stage, 'ready')
    state.toggleItem('following', '301')
    await state.begin()
    assert.equal(state.job.value.stage, 'completed')
    state.toggleItem('bookmarks', '401')
    assert.equal(state.chosenCount.value, 1)
    const oldFollowing = state.previewItems.following.map((item) => item.id)
    const oldBookmark = state.previewItems.bookmarks.map((item) => item.id)
    followingSource = [first, second, third]
    followingTarget = [first, second]

    pageCalls.length = 0
    failFollowing = true
    await state.refreshKind('following')
    assert.equal(state.job.value.stage, 'completed')
    assert.match(state.error.value, /Target list unavailable/)
    assert.deepEqual(
      state.previewItems.following.map((item) => item.id),
      oldFollowing,
    )
    assert.equal(state.chosenIds.bookmarks.has('401'), true)
    assert.deepEqual(pageCalls.sort(), [
      ['source', 'following'],
      ['target', 'following'],
    ])

    pageCalls.length = 0
    failFollowing = false
    await state.refreshKind('following')
    assert.equal(state.error.value, '')
    assert.deepEqual(
      state.previewItems.following.map((item) => item.id),
      ['301', '302', '303'],
    )
    assert.deepEqual(state.job.value.summary.following, { source: 3, alreadyThere: 2, toCopy: 1 })
    assert.deepEqual(
      state.previewItems.bookmarks.map((item) => item.id),
      oldBookmark,
    )
    assert.equal(state.chosenIds.bookmarks.has('401'), true)
    assert.deepEqual(pageCalls.sort(), [
      ['source', 'following'],
      ['target', 'following'],
    ])

    bookmarksSource = [savedPost, nextPost]
    bookmarksTarget = [savedPost]
    pageCalls.length = 0
    await state.refreshKind('bookmarks')
    assert.deepEqual(
      state.previewItems.bookmarks.map((item) => item.id),
      ['401', '402'],
    )
    assert.equal(state.chosenIds.bookmarks.has('401'), false)
    assert.deepEqual(state.job.value.summary.bookmarks, { source: 2, alreadyThere: 1, toCopy: 1 })
    assert.deepEqual(state.job.value.summary.following, { source: 3, alreadyThere: 2, toCopy: 1 })
    assert.deepEqual(pageCalls.sort(), [
      ['source', 'bookmarks'],
      ['target', 'bookmarks'],
    ])
  } finally {
    app?.unmount()
    globalThis.fetch = originalFetch
  }
})

test('stopping a list refresh keeps the previous preview and selections', async () => {
  globalThis.sessionStorage = storage()
  const originalFetch = globalThis.fetch
  const bookmark = {
    id: '401',
    label: 'Saved',
    detail: '@writer',
    url: 'https://x.com/i/web/status/401',
    avatarUrl: null,
  }
  let holdRequests = false
  let pendingRequests = 0
  let requestsStarted = () => {}
  const started = new Promise((resolve) => {
    requestsStarted = resolve
  })
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === '/api/connect')
      return Response.json({ account: body.authToken === 'source-token' ? source : target })
    assert.equal(url, '/api/page')
    if (holdRequests) {
      pendingRequests++
      if (pendingRequests === 2) requestsStarted()
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    return Response.json({
      items:
        body.kind === 'bookmarks'
          ? body.authToken === 'source-token'
            ? [bookmark]
            : []
          : body.authToken === 'source-token'
            ? [first, second]
            : [second],
      cursor: null,
    })
  }

  let app
  try {
    app = mount()
    const state = app.migration
    state.credentials.source.authToken = 'source-token'
    state.credentials.source.ct0 = 'source-csrf'
    state.credentials.target.authToken = 'target-token'
    state.credentials.target.ct0 = 'target-csrf'
    await state.connect('source')
    await state.connect('target')
    state.selected.bookmarks = false
    await state.scan()
    state.toggleItem('following', '301')
    holdRequests = true
    const refreshing = state.refreshKind('following')
    await started
    assert.equal(state.taskActive.value, true)
    assert.equal(state.canChooseItems.value, false)
    assert.equal(state.loadingItems.following, true)
    await state.cancel()
    await refreshing
    assert.equal(state.job.value.stage, 'ready')
    assert.equal(state.error.value, '')
    assert.equal(state.loadingItems.following, false)
    assert.equal(state.chosenIds.following.has('301'), true)
    assert.deepEqual(
      state.previewItems.following.map((item) => item.id),
      ['301', '302'],
    )
    holdRequests = false
    await state.refreshKind('bookmarks')
    assert.equal(state.selected.bookmarks, true)
    assert.equal(state.job.value.selected.bookmarks, true)
    assert.equal(state.previewComplete.value, true)
    assert.deepEqual(
      state.previewItems.bookmarks.map((item) => item.id),
      ['401'],
    )
    assert.equal(state.chosenIds.following.has('301'), true)
  } finally {
    app?.unmount()
    globalThis.fetch = originalFetch
  }
})
