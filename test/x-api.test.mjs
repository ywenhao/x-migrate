import assert from 'node:assert/strict'
import { test } from 'node:test'
import { XClient, parseTimeline } from '../shared/x-api.ts'
import { readCompleteList } from '../shared/pagination.ts'

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
test('known follow count mismatch is flagged even when X omits the next cursor', async () => {
  let inferred = false
  const items = await readCompleteList(
    'following',
    2,
    async () => ({ items: [{ id: '301' }], cursor: null }),
    (_count, _page, end) => {
      inferred = end
    },
  )
  assert.equal(items.length, 1)
  assert.equal(inferred, true)
})

test('query ID discovery stops at the requested operation and reuses downloaded scripts', async () => {
  const first = 'https://abs.twimg.com/responsive-web/client-web/first.js'
  const second = 'https://abs.twimg.com/responsive-web/client-web/second.js'
  const calls = []
  const client = new XClient('fake', 'fake', {}, async (url) => {
    calls.push(url)
    const body = url.endsWith('/home')
      ? '<script src="' + first + '"></script><script src="' + second + '"></script>'
      : url === first
        ? 'queryId:"following123",operationName:"Following"'
        : 'queryId:"bookmarks123",operationName:"Bookmarks"'
    return new Response(body)
  })
  assert.equal(await client.operationId('Following'), 'following123')
  assert.deepEqual(calls, ['https://x.com/home', first])
  assert.equal(await client.operationId('Bookmarks'), 'bookmarks123')
  assert.deepEqual(calls, ['https://x.com/home', first, second])
})

test('X errors name the GraphQL operation without echoing request parameters', async () => {
  const client = new XClient('fake', 'fake', {}, async () => new Response('{}', { status: 404 }))
  await assert.rejects(
    client.json('GET', '/i/api/graphql/invalidid/Viewer?variables=secret'),
    (error) => {
      assert.match(error.message, /Viewer 返回 404/)
      assert.doesNotMatch(error.message, /secret/)
      return true
    },
  )
})
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
