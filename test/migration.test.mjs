import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { xApiPlugin } from '../server/plugin.ts'
import { XClient, parseTimeline } from '../server/x-api.ts'

const user = (id, handle) => ({ id, label: handle, detail: `@${handle}`, url: `https://x.com/${handle}`, avatarUrl: null })
const tweet = (id) => ({ id, label: `推文 ${id}`, detail: '@author', url: `https://x.com/i/web/status/${id}`, avatarUrl: null })
const sourceAccount = { id: '100', screenName: 'old_account', name: 'Old', avatarUrl: null }
const targetAccount = { id: '200', screenName: 'new_account', name: 'New', avatarUrl: null }
const actions = []
let failFollow = false
let server
let base
const originalCreate = XClient.create

const sourceClient = {
  verify: async () => sourceAccount,
  following: async () => [user('301', 'first'), user('302', 'second')],
  bookmarks: async () => [tweet('401'), tweet('402')],
  unfollow: async (id) => { actions.push(`source:unfollow:${id}`) },
  removeBookmark: async (id) => { actions.push(`source:unbookmark:${id}`) },
  close: async () => {},
}
const targetClient = {
  verify: async () => targetAccount,
  following: async () => [user('302', 'second')],
  bookmarks: async () => [tweet('402')],
  follow: async (id) => {
    actions.push(`target:follow:${id}`)
    if (failFollow) throw new Error('目标账号无法关注')
  },
  addBookmark: async (id) => { actions.push(`target:bookmark:${id}`) },
  close: async () => {},
}

test('解析 X 时间线中的用户、推文和底部分页游标', () => {
  const followingEntries = [
    { content: { itemContent: { user_results: { result: {
      rest_id: '301', core: { screen_name: 'first', name: 'First User' },
      avatar: { image_url: 'https://pbs.twimg.com/first.jpg' },
    } } } } },
    { content: { cursorType: 'Bottom', value: 'next-following' } },
  ]
  const followingResponse = {
    data: { user: { result: { timeline: { timeline: {
      instructions: [{ type: 'TimelineAddEntries', entries: followingEntries }],
    } } } } },
  }
  const following = parseTimeline(followingResponse, 'following')
  assert.equal(following.items[0].id, '301')
  assert.equal(following.items[0].detail, '@first')
  assert.equal(following.cursor, 'next-following')

  const bookmarkEntries = [
    { content: { itemContent: { tweet_results: { result: {
      __typename: 'TweetWithVisibilityResults',
      tweet: {
        rest_id: '401', legacy: { full_text: 'saved text' },
        core: { user_results: { result: { core: { screen_name: 'author' } } } },
      },
    } } } } },
    { content: { cursorType: 'Bottom', value: 'next-bookmarks' } },
  ]
  const bookmarksResponse = {
    data: { bookmark_timeline_v2: { timeline: {
      instructions: [{ type: 'TimelineAddEntries', entries: bookmarkEntries }],
    } } },
  }
  const bookmarks = parseTimeline(bookmarksResponse, 'bookmarks')
  assert.equal(bookmarks.items[0].id, '401')
  assert.equal(bookmarks.items[0].label, 'saved text')
  assert.equal(bookmarks.cursor, 'next-bookmarks')
})

async function post(path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() }
}

async function waitFor(jobId, stage) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/jobs/${jobId}`)
    const { job } = await response.json()
    if (job.stage === stage) return job
    if (job.stage === 'failed') throw new Error(job.message)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for ${stage}`)
}

before(async () => {
  XClient.create = async (authToken) => authToken.startsWith('source') ? sourceClient : targetClient
  server = await createServer({
    configFile: false,
    plugins: [xApiPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
})

after(async () => {
  XClient.create = originalCreate
  await server?.close()
})

test('预览去重、移除确认及先迁入后移除', async () => {
  const source = await post('/connect', { authToken: 'source1234', ct0: 'sourcecsrf' })
  const target = await post('/connect', { authToken: 'target1234', ct0: 'targetcsrf' })
  assert.equal(source.status, 200)
  assert.equal(target.status, 200)

  const scan = await post('/scan', {
    sourceSessionId: source.data.sessionId,
    targetSessionId: target.data.sessionId,
    following: true,
    bookmarks: true,
  })
  assert.equal(scan.status, 202)
  const jobId = scan.data.job.id
  const ready = await waitFor(jobId, 'ready')
  assert.deepEqual(ready.summary.following, { source: 2, alreadyThere: 1, toCopy: 1 })
  assert.deepEqual(ready.summary.bookmarks, { source: 2, alreadyThere: 1, toCopy: 1 })

  const rejected = await post(`/jobs/${jobId}/start`, {
    removeFollowing: true,
    removeBookmarks: true,
    removeConfirmation: '@wrong_account',
  })
  assert.equal(rejected.status, 400)
  assert.match(rejected.data.error, /old_account/)

  const started = await post(`/jobs/${jobId}/start`, {
    removeFollowing: true,
    removeBookmarks: true,
    removeConfirmation: '@old_account',
  })
  assert.equal(started.status, 202)
  const completed = await waitFor(jobId, 'completed')
  assert.equal(completed.progress.copied, 2)
  assert.equal(completed.progress.alreadyThere, 2)
  assert.equal(completed.progress.removed, 4)
  assert.equal(completed.progress.failed, 0)
  assert.ok(actions.indexOf('target:follow:301') < actions.indexOf('source:unfollow:301'))
  assert.ok(actions.indexOf('target:bookmark:401') < actions.indexOf('source:unbookmark:401'))
  assert.ok(actions.includes('source:unfollow:302'))
  assert.ok(actions.includes('source:unbookmark:402'))

  const repeated = await post(`/jobs/${jobId}/start`, {})
  assert.equal(repeated.status, 409)
})

test('目标账号新增失败时不移除对应旧账号关注', async () => {
  actions.length = 0
  failFollow = true
  const source = await post('/connect', { authToken: 'source1234', ct0: 'sourcecsrf' })
  const target = await post('/connect', { authToken: 'target1234', ct0: 'targetcsrf' })
  const scan = await post('/scan', {
    sourceSessionId: source.data.sessionId,
    targetSessionId: target.data.sessionId,
    following: true,
    bookmarks: false,
  })
  const jobId = scan.data.job.id
  await waitFor(jobId, 'ready')
  const started = await post(`/jobs/${jobId}/start`, {
    removeFollowing: true,
    removeConfirmation: '@old_account',
  })
  assert.equal(started.status, 202)
  const completed = await waitFor(jobId, 'completed')
  assert.equal(completed.progress.failed, 1)
  assert.ok(actions.includes('target:follow:301'))
  assert.ok(!actions.includes('source:unfollow:301'))
  assert.ok(actions.includes('source:unfollow:302'))
})
