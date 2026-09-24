import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { xApiPlugin } from '../server/plugin.ts'
import { XApiError, XClient, parseTimeline } from '../server/x-api.ts'

const user = (id, handle) => ({
  id,
  label: handle,
  detail: `@${handle}`,
  url: `https://x.com/${handle}`,
  avatarUrl: null,
})
const tweet = (id) => ({
  id,
  label: `推文 ${id}`,
  detail: '@author',
  url: `https://x.com/i/web/status/${id}`,
  avatarUrl: null,
})
const sourceAccount = {
  id: '100',
  screenName: 'old_account',
  name: 'Old',
  avatarUrl: null,
  followingCount: 2,
}
const targetAccount = {
  id: '200',
  screenName: 'new_account',
  name: 'New',
  avatarUrl: null,
  followingCount: 1,
}
const actions = []
let failFollow = false
let server
let base
const originalCreate = XClient.create

const sourceClient = {
  verify: async () => sourceAccount,
  following: async () => [user('301', 'first'), user('302', 'second')],
  bookmarks: async () => [tweet('401'), tweet('402')],
  unfollow: async (id) => {
    actions.push(`source:unfollow:${id}`)
  },
  removeBookmark: async (id) => {
    actions.push(`source:unbookmark:${id}`)
  },
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
  addBookmark: async (id) => {
    actions.push(`target:bookmark:${id}`)
  },
  close: async () => {},
}

test('解析 X 时间线中的用户、推文和底部分页游标', () => {
  const followingEntries = [
    {
      content: {
        itemContent: {
          user_results: {
            result: {
              rest_id: '301',
              core: { screen_name: 'first', name: 'First User' },
              avatar: { image_url: 'https://pbs.twimg.com/first.jpg' },
            },
          },
        },
      },
    },
    { content: { cursorType: 'Bottom', value: 'next-following' } },
  ]
  const followingResponse = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{ type: 'TimelineAddEntries', entries: followingEntries }],
            },
          },
        },
      },
    },
  }
  const following = parseTimeline(followingResponse, 'following')
  assert.equal(following.items[0].id, '301')
  assert.equal(following.items[0].detail, '@first')
  assert.equal(following.cursor, 'next-following')

  const bookmarkEntries = [
    {
      content: {
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'TweetWithVisibilityResults',
              tweet: {
                rest_id: '401',
                legacy: { full_text: 'saved text' },
                core: { user_results: { result: { core: { screen_name: 'author' } } } },
              },
            },
          },
        },
      },
    },
    { content: { cursorType: 'Bottom', value: 'next-bookmarks', stopOnEmptyResponse: true } },
  ]
  const bookmarksResponse = {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries: bookmarkEntries }],
        },
      },
    },
  }
  const bookmarks = parseTimeline(bookmarksResponse, 'bookmarks')
  assert.equal(bookmarks.items[0].id, '401')
  assert.equal(bookmarks.items[0].label, 'saved text')
  assert.equal(bookmarks.cursor, 'next-bookmarks')

  const terminalEntries = [
    { content: { cursorType: 'Top', value: 'previous' } },
    { content: { cursorType: 'Bottom', value: 'same-cursor', stopOnEmptyResponse: true } },
  ]
  const terminalBookmarks = {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries: terminalEntries }],
        },
      },
    },
  }
  const terminalFollowing = {
    data: {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [{ type: 'TimelineAddEntries', entries: terminalEntries }],
            },
          },
        },
      },
    },
  }
  assert.deepEqual(parseTimeline(terminalBookmarks, 'bookmarks'), { items: [], cursor: null })
  assert.deepEqual(parseTimeline(terminalFollowing, 'following'), { items: [], cursor: null })
})

test('收藏空页带停止标记时结束分页', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  let requests = 0
  client.graphqlGet = async () => {
    requests++
    const entries =
      requests === 1
        ? [
            {
              content: {
                itemContent: {
                  tweet_results: {
                    result: {
                      rest_id: '401',
                      legacy: { full_text: 'saved text' },
                    },
                  },
                },
              },
            },
            { content: { cursorType: 'Bottom', value: 'last-cursor' } },
          ]
        : [{ content: { cursorType: 'Bottom', value: 'last-cursor', stopOnEmptyResponse: true } }]
    return {
      data: {
        bookmark_timeline_v2: {
          timeline: {
            instructions: [{ type: 'TimelineAddEntries', entries }],
          },
        },
      },
    }
  }
  const items = await client.bookmarks()
  assert.equal(requests, 2)
  assert.equal(items.length, 1)
  assert.equal(items[0].id, '401')
})

test('Viewer 账号资料提供关注总数', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  client.graphqlGet = async (operation) => {
    assert.equal(operation, 'Viewer')
    return {
      data: {
        viewer: {
          user_results: {
            result: {
              rest_id: '100',
              core: { screen_name: 'old_account', name: 'Old' },
              relationship_counts: { following: 1170 },
            },
          },
        },
      },
    }
  }
  const account = await client.verify()
  assert.equal(account.followingCount, 1170)
})

test('Viewer 缺少关注总数时从账号资料补全', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  const operations = []
  client.graphqlGet = async (operation) => {
    operations.push(operation)
    const result = {
      rest_id: '100',
      core: { screen_name: 'old_account', name: 'Old' },
      ...(operation === 'UserByScreenName' ? { relationship_counts: { following: 1170 } } : {}),
    }
    return operation === 'Viewer'
      ? { data: { viewer: { user_results: { result } } } }
      : { data: { user: { result } } }
  }
  const account = await client.verify()
  assert.equal(account.followingCount, 1170)
  assert.deepEqual(operations, ['Viewer', 'UserByScreenName'])
})

test('账号资料的最新关注总数覆盖 Viewer 旧值', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  client.graphqlGet = async (operation) => {
    const result = {
      rest_id: '100',
      core: { screen_name: 'old_account', name: 'Old' },
      relationship_counts: { following: operation === 'Viewer' ? 1169 : 1170 },
    }
    return operation === 'Viewer'
      ? { data: { viewer: { user_results: { result } } } }
      : { data: { user: { result } } }
  }
  assert.equal((await client.verify()).followingCount, 1170)
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
  XClient.create = async (authToken) =>
    authToken.startsWith('source') ? sourceClient : targetClient
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
  const englishReady = await fetch(`${base}/api/jobs/${jobId}`, {
    headers: { 'accept-language': 'en-US' },
  }).then((response) => response.json())
  assert.match(englishReady.job.message, /Scan complete/)
  assert.match(ready.message, /扫描完成/)
  assert.deepEqual(ready.summary.following, { source: 2, alreadyThere: 1, toCopy: 1 })
  assert.deepEqual(ready.summary.bookmarks, { source: 2, alreadyThere: 1, toCopy: 1 })
  assert.equal(ready.scanProgress.following.source.total, 2)
  assert.equal(ready.scanProgress.following.source.read, 2)
  assert.equal(ready.scanProgress.following.target.total, 1)
  assert.equal(ready.scanProgress.bookmarks.source.total, 2)
  assert.equal(ready.scanProgress.bookmarks.target.total, 1)

  const rejected = await post(`/jobs/${jobId}/start`, {
    followingIds: ['301'],
    bookmarkIds: ['401'],
    removeFollowing: true,
    removeBookmarks: true,
    removeConfirmation: '@wrong_account',
  })
  assert.equal(rejected.status, 400)
  assert.match(rejected.data.error, /old_account/)
  const englishRejected = await fetch(`${base}/api/jobs/${jobId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'en-US' },
    body: JSON.stringify({
      followingIds: ['301'],
      bookmarkIds: ['401'],
      removeFollowing: true,
      removeConfirmation: '@wrong_account',
    }),
  })
  assert.equal(englishRejected.status, 400)
  assert.match((await englishRejected.json()).error, /Enter @old_account/)

  const nothingSelected = await post(`/jobs/${jobId}/start`, { followingIds: [], bookmarkIds: [] })
  assert.equal(nothingSelected.status, 400)
  assert.match(nothingSelected.data.error, /至少勾选一项/)

  const existingRejected = await post(`/jobs/${jobId}/start`, {
    followingIds: ['302'],
    bookmarkIds: [],
  })
  assert.equal(existingRejected.status, 400)
  assert.match(existingRejected.data.error, /已经拥有/)

  const started = await post(`/jobs/${jobId}/start`, {
    followingIds: ['301'],
    bookmarkIds: ['401'],
    removeFollowing: true,
    removeBookmarks: true,
    removeConfirmation: '@old_account',
  })
  assert.equal(started.status, 202)
  const completed = await waitFor(jobId, 'completed')
  assert.equal(completed.progress.total, 2)
  assert.equal(completed.progress.copied, 2)
  assert.equal(completed.progress.alreadyThere, 0)
  assert.equal(completed.progress.removed, 2)
  assert.equal(completed.progress.failed, 0)
  assert.ok(actions.indexOf('target:follow:301') < actions.indexOf('source:unfollow:301'))
  assert.ok(actions.indexOf('target:bookmark:401') < actions.indexOf('source:unbookmark:401'))
  assert.ok(!actions.includes('source:unfollow:302'))
  assert.ok(!actions.includes('source:unbookmark:402'))

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
    followingIds: ['301'],
    bookmarkIds: [],
    removeFollowing: true,
    removeConfirmation: '@old_account',
  })
  assert.equal(started.status, 202)
  const completed = await waitFor(jobId, 'completed')
  assert.equal(completed.progress.failed, 1)
  assert.ok(actions.includes('target:follow:301'))
  assert.ok(!actions.includes('source:unfollow:301'))
  assert.ok(!actions.includes('source:unfollow:302'))
})

test('429 暂停后可手动继续同一项目', async () => {
  const originalFollow = targetClient.follow
  let calls = 0
  targetClient.follow = async () => {
    calls++
    if (calls === 1) throw new XApiError('X 接口已限流。', 429)
  }
  try {
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
    await post(`/jobs/${jobId}/start`, { followingIds: ['301'], bookmarkIds: [] })
    const paused = await waitFor(jobId, 'paused')
    assert.ok(paused.retryAt > Date.now() + 14 * 60 * 1000)
    assert.equal(paused.progress.processed, 0)
    assert.equal(paused.progress.failed, 0)
    const resumed = await post(`/jobs/${jobId}/resume`, {})
    assert.equal(resumed.status, 200)
    const completed = await waitFor(jobId, 'completed')
    assert.equal(completed.progress.copied, 1)
    assert.equal(completed.progress.processed, 1)
    assert.equal(calls, 2)
  } finally {
    targetClient.follow = originalFollow
  }
})

test('429 按恢复时间自动继续，也可在暂停时停止', async () => {
  const originalFollow = targetClient.follow
  let calls = 0
  targetClient.follow = async () => {
    calls++
    if (calls === 1) throw new XApiError('X 接口已限流。', 429, Date.now() + 5_000)
  }
  try {
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
    await post(`/jobs/${jobId}/start`, { followingIds: ['301'], bookmarkIds: [] })
    await waitFor(jobId, 'paused')
    const completed = await waitFor(jobId, 'completed')
    assert.equal(completed.progress.copied, 1)
    assert.equal(calls, 2)

    targetClient.follow = async () => {
      calls++
      throw new XApiError('X 接口已限流。', 429)
    }
    const next = await post('/scan', {
      sourceSessionId: source.data.sessionId,
      targetSessionId: target.data.sessionId,
      following: true,
      bookmarks: false,
    })
    const nextJobId = next.data.job.id
    await waitFor(nextJobId, 'ready')
    await post(`/jobs/${nextJobId}/start`, { followingIds: ['301'], bookmarkIds: [] })
    await waitFor(nextJobId, 'paused')
    const stopped = await post(`/jobs/${nextJobId}/cancel`, {})
    assert.equal(stopped.data.job.stage, 'cancelled')
  } finally {
    targetClient.follow = originalFollow
  }
})

test('旧账号清理限流后继续，不重复新增目标内容', async () => {
  const originalFollow = targetClient.follow
  const originalUnfollow = sourceClient.unfollow
  let follows = 0
  let unfollows = 0
  targetClient.follow = async () => {
    follows++
  }
  sourceClient.unfollow = async () => {
    unfollows++
    if (unfollows === 1) throw new XApiError('X 接口已限流。', 429)
  }
  try {
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
    await post(`/jobs/${jobId}/start`, {
      followingIds: ['301'],
      bookmarkIds: [],
      removeFollowing: true,
      removeConfirmation: '@old_account',
    })
    await waitFor(jobId, 'paused')
    await post(`/jobs/${jobId}/resume`, {})
    const completed = await waitFor(jobId, 'completed')
    assert.equal(completed.progress.copied, 1)
    assert.equal(completed.progress.removed, 1)
    assert.equal(completed.progress.processed, 1)
    assert.equal(follows, 1)
    assert.equal(unfollows, 2)
  } finally {
    targetClient.follow = originalFollow
    sourceClient.unfollow = originalUnfollow
  }
})

test('刷新可读取会话，停止扫描会立即中断当前读取', async () => {
  const originalFollowing = sourceClient.following
  let signalReceived
  const started = new Promise((resolve) => {
    signalReceived = resolve
  })
  let aborted = false
  sourceClient.following = async (_account, _onPage, signal) => {
    signalReceived()
    await new Promise((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(new Error('scan aborted'))
        },
        { once: true },
      )
    })
    return []
  }

  try {
    const source = await post('/connect', { authToken: 'source1234', ct0: 'sourcecsrf' })
    const target = await post('/connect', { authToken: 'target1234', ct0: 'targetcsrf' })
    const restored = await fetch(`${base}/api/sessions/${source.data.sessionId}`)
    assert.equal(restored.status, 200)
    assert.deepEqual((await restored.json()).account, sourceAccount)

    const scan = await post('/scan', {
      sourceSessionId: source.data.sessionId,
      targetSessionId: target.data.sessionId,
      following: true,
      bookmarks: false,
    })
    await started
    const stopped = await post(`/jobs/${scan.data.job.id}/cancel`, {})
    assert.equal(stopped.status, 200)
    assert.equal(stopped.data.job.stage, 'cancelled')
    assert.equal(aborted, true)
  } finally {
    sourceClient.following = originalFollowing
  }
})

test('连续无新增项目时安全停止分页', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  let page = 0
  client.graphqlGet = async (_operation, variables) => {
    assert.equal(variables.count, 100)
    return {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  { entries: [{ content: { cursorType: 'Bottom', value: `cursor-${++page}` } }] },
                ],
              },
            },
          },
        },
      },
    }
  }
  await assert.rejects(() => client.following(sourceAccount), /连续 10 页未返回新的关注项目/)
  assert.equal(page, 10)
})

test('关注人数达到账号总数后，下一页无新增即结束扫描', async () => {
  const client = new XClient('fake', 'fake', {}, {})
  let page = 0
  client.graphqlGet = async () => {
    page++
    const entries =
      page === 1
        ? [
            {
              content: {
                itemContent: {
                  user_results: {
                    result: {
                      rest_id: '301',
                      core: { screen_name: 'first', name: 'First User' },
                    },
                  },
                },
              },
            },
            { content: { cursorType: 'Bottom', value: 'cursor-1' } },
          ]
        : [{ content: { cursorType: 'Bottom', value: `cursor-${page}` } }]
    return {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [{ type: 'TimelineAddEntries', entries }],
              },
            },
          },
        },
      },
    }
  }
  const items = await client.following({ ...sourceAccount, followingCount: 1 })
  assert.equal(items.length, 1)
  assert.equal(page, 2)
})

test('收藏连续空页或重复游标时按末尾处理', async () => {
  const response = (entries) => ({
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries }],
        },
      },
    },
  })
  const saved = {
    content: {
      itemContent: {
        tweet_results: {
          result: {
            rest_id: '401',
            legacy: { full_text: 'saved text' },
          },
        },
      },
    },
  }

  for (const cursors of [
    ['cursor-1', 'cursor-2', 'cursor-3'],
    ['cursor-1', 'cursor-1'],
  ]) {
    const client = new XClient('fake', 'fake', {}, {})
    let page = 0
    let inferredEnd = false
    client.graphqlGet = async () => {
      const cursor = cursors[page++]
      return response(
        page === 1
          ? [saved, { content: { cursorType: 'Bottom', value: cursor } }]
          : [{ content: { cursorType: 'Bottom', value: cursor } }],
      )
    }
    const items = await client.bookmarks((_count, _page, inferred) => {
      inferredEnd = inferred
    })
    assert.equal(items.length, 1)
    assert.equal(page, cursors.length)
    assert.equal(inferredEnd, true)
  }
})
