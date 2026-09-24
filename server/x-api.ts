import { request, type Dispatcher } from 'undici'
import { ClientTransaction } from 'x-client-transaction-id'
import { parseHTML } from 'linkedom'
import { makeDispatcher, resolveProxyUrl } from './proxy.ts'
import features from './features.json' with { type: 'json' }

const X_ORIGIN = 'https://x.com'
const ASSET_ORIGIN = 'https://abs.twimg.com'
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const OPERATIONS = new Set(['Following', 'Bookmarks', 'CreateBookmark', 'DeleteBookmark'])
const DISCOVERY_TTL = 60 * 60 * 1000
const MAX_PAGES = 500
const MAX_ASSETS = 45
// X 的完整 feature 快照有数百项。GraphQL 请求只发送这些时间线字段，
// 避免 URL 超长，并减少过期 feature 对请求的影响。
const FEATURE_KEYS = [
  'rweb_video_screen_enabled',
  'rweb_cashtags_enabled',
  'profile_label_improvements_pcf_label_in_post_enabled',
  'responsive_web_profile_redirect_enabled',
  'rweb_tipjar_consumption_enabled',
  'verified_phone_label_enabled',
  'creator_subscriptions_tweet_preview_api_enabled',
  'responsive_web_graphql_timeline_navigation_enabled',
  'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
  'premium_content_api_read_enabled',
  'communities_web_enable_tweet_community_results_fetch',
  'c9s_tweet_anatomy_moderator_badge_enabled',
  'responsive_web_grok_analyze_button_fetch_trends_enabled',
  'responsive_web_grok_analyze_post_followups_enabled',
  'responsive_web_jetfuel_frame',
  'responsive_web_grok_share_attachment_enabled',
  'responsive_web_grok_annotations_enabled',
  'articles_preview_enabled',
  'responsive_web_edit_tweet_api_enabled',
  'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
  'view_counts_everywhere_api_enabled',
  'longform_notetweets_consumption_enabled',
  'responsive_web_twitter_article_tweet_consumption_enabled',
  'content_disclosure_indicator_enabled',
  'content_disclosure_ai_generated_indicator_enabled',
  'responsive_web_grok_show_grok_translated_post',
  'responsive_web_grok_analysis_button_from_backend',
  'post_ctas_fetch_enabled',
  'freedom_of_speech_not_reach_fetch_enabled',
  'standardized_nudges_misinfo',
  'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
  'longform_notetweets_rich_text_read_enabled',
  'longform_notetweets_inline_media_enabled',
  'responsive_web_grok_image_annotation_enabled',
  'responsive_web_grok_imagine_annotation_enabled',
  'responsive_web_grok_community_note_auto_translation_is_enabled',
  'responsive_web_enhance_cards_enabled',
] as const
const graphqlFeatures = Object.fromEntries(FEATURE_KEYS
  .filter((key) => typeof (features as Record<string, unknown>)[key] === 'boolean')
  .map((key) => [key, (features as Record<string, unknown>)[key]]))

export type Operation = 'Following' | 'Bookmarks' | 'CreateBookmark' | 'DeleteBookmark'
export type QueryIds = Partial<Record<Operation, string>>

export interface Account {
  id: string
  screenName: string
  name: string
  avatarUrl: string | null
}

export interface MigrationItem {
  id: string
  label: string
  detail: string
  url: string
  avatarUrl: string | null
}

type JsonObject = Record<string, unknown>

let discoveredIds: QueryIds = {}
let discoveredAt = 0

export class XApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'XApiError'
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => asObject(current)[key], value)
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function entriesFromInstructions(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  const entries: JsonObject[] = []
  for (const instruction of value) {
    const item = asObject(instruction)
    if (Array.isArray(item.entries)) entries.push(...item.entries.map(asObject))
    if (item.entry) entries.push(asObject(item.entry))
  }
  return entries
}

function itemContents(entry: JsonObject): JsonObject[] {
  const content = asObject(entry.content)
  const result: JsonObject[] = []
  if (content.itemContent) result.push(asObject(content.itemContent))
  if (Array.isArray(content.items)) {
    for (const item of content.items) {
      const wrapped = asObject(item)
      const nested = asObject(wrapped.item ?? wrapped)
      if (nested.itemContent) result.push(asObject(nested.itemContent))
    }
  }
  return result
}

function bottomCursor(entries: JsonObject[]): string | null {
  for (const entry of entries) {
    const content = asObject(entry.content)
    if (content.cursorType === 'Bottom') return string(content.value) || null
  }
  return null
}

function userItem(raw: unknown): MigrationItem | null {
  const user = asObject(raw)
  const id = string(user.rest_id)
  const screenName = string(at(user, 'core', 'screen_name')) || string(at(user, 'legacy', 'screen_name'))
  if (!id || !screenName) return null
  const name = string(at(user, 'core', 'name')) || string(at(user, 'legacy', 'name')) || screenName
  return {
    id,
    label: name,
    detail: `@${screenName}`,
    url: `${X_ORIGIN}/${encodeURIComponent(screenName)}`,
    avatarUrl: string(at(user, 'avatar', 'image_url')) ||
      string(at(user, 'legacy', 'profile_image_url_https')) || null,
  }
}

function tweetItem(raw: unknown): MigrationItem | null {
  let tweet = asObject(raw)
  if (tweet.__typename === 'TweetWithVisibilityResults') tweet = asObject(tweet.tweet)
  const id = string(tweet.rest_id)
  if (!id) return null
  const text = string(at(tweet, 'note_tweet', 'note_tweet_results', 'result', 'text')) ||
    string(at(tweet, 'legacy', 'full_text')) || '无法显示推文内容'
  const author = asObject(at(tweet, 'core', 'user_results', 'result'))
  const handle = string(at(author, 'core', 'screen_name')) ||
    string(at(author, 'legacy', 'screen_name'))
  return {
    id,
    label: text,
    detail: handle ? `@${handle}` : `推文 ${id}`,
    url: `${X_ORIGIN}/i/web/status/${id}`,
    avatarUrl: string(at(author, 'avatar', 'image_url')) ||
      string(at(author, 'legacy', 'profile_image_url_https')) || null,
  }
}

export function parseTimeline(body: unknown, kind: 'following' | 'bookmarks'): {
  items: MigrationItem[]
  cursor: string | null
} {
  const instructions = kind === 'following'
    ? at(body, 'data', 'user', 'result', 'timeline', 'timeline', 'instructions')
    : at(body, 'data', 'bookmark_timeline_v2', 'timeline', 'instructions')
  if (!Array.isArray(instructions)) {
    throw new XApiError(`X 返回的${kind === 'following' ? '关注' : '收藏'}列表结构已变化，无法安全读取。`)
  }
  const entries = entriesFromInstructions(instructions)
  const items: MigrationItem[] = []
  for (const entry of entries) {
    for (const content of itemContents(entry)) {
      const raw = kind === 'following'
        ? at(content, 'user_results', 'result')
        : at(content, 'tweet_results', 'result')
      const parsed = kind === 'following' ? userItem(raw) : tweetItem(raw)
      if (parsed) items.push(parsed)
    }
  }
  return { items, cursor: bottomCursor(entries) }
}

function findOperations(script: string, map: QueryIds): void {
  const patterns = [
    /queryId\s*:\s*["']([\w-]+)["']\s*,\s*operationName\s*:\s*["']([\w]+)["']/g,
    /operationName\s*:\s*["']([\w]+)["'][^}]{0,150}?queryId\s*:\s*["']([\w-]+)["']/g,
  ]
  for (const [index, pattern] of patterns.entries()) {
    for (const match of script.matchAll(pattern)) {
      const operation = (index === 0 ? match[2] : match[1]) as Operation
      const id = index === 0 ? match[1] : match[2]
      if (OPERATIONS.has(operation)) map[operation] = id
    }
  }
}

function scriptUrls(text: string): string[] {
  const found = new Set<string>()
  const absolute = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s)]+?\.js/g
  for (const match of text.matchAll(absolute)) found.add(match[0])
  const tags = /<script[^>]+src=["']([^"']+\.js)["']/g
  for (const match of text.matchAll(tags)) {
    try {
      const url = new URL(match[1], X_ORIGIN)
      if (url.origin === ASSET_ORIGIN || url.origin === X_ORIGIN) found.add(url.toString())
    } catch { /* Ignore malformed URLs from page content. */ }
  }
  return [...found]
}

function runtimeChunkUrls(html: string): string[] {
  // X 的首页内联 webpack runtime 持有懒加载 chunk 的名称和 hash。
  // Bookmarks 查询定义常在 shared~bundle.BookmarkFolders~bundle.Bookmarks 中，
  // 该脚本不会作为首页的 <script src> 出现。
  const start = html.indexOf('p.u=e=>')
  const end = html.indexOf('p.hmd=', start)
  if (start < 0 || end < start || end - start > 100_000) return []
  const runtime = html.slice(start, end)
  const names = new Map<string, string>()
  const hashes = new Map<string, string>()
  for (const match of runtime.matchAll(/(\d+):["']([^"']+)["']/g)) {
    if (/^[a-f\d]{12,}$/.test(match[2])) hashes.set(match[1], match[2])
    else names.set(match[1], match[2])
  }
  const suffix = runtime.match(/\}\)\[e\]\+["']([^"']+\.js)["']/)?.[1] || '.js'
  const urls: string[] = []
  for (const [id, name] of names) {
    const hash = hashes.get(id)
    if (hash && /^[\w./~-]+$/.test(name)) {
      urls.push(`${ASSET_ORIGIN}/responsive-web/client-web/${name}.${hash}${suffix}`)
    }
  }
  return urls
}

function safeErrorMessage(body: unknown): string {
  const errors = asObject(body).errors
  if (Array.isArray(errors)) {
    const message = string(asObject(errors[0]).message)
    if (message) return message.slice(0, 180)
  }
  return ''
}

export function validateSessionInput(authToken: unknown, ct0: unknown): {
  authToken: string
  ct0: string
} {
  const token = string(authToken).trim()
  const csrf = string(ct0).trim()
  const valid = (value: string) => value.length >= 8 && value.length <= 512 && !/[\s;,\r\n]/.test(value)
  if (!valid(token) || !valid(csrf)) {
    throw new XApiError('请填写有效的 auth_token 和 ct0 Cookie 值。')
  }
  return { authToken: token, ct0: csrf }
}

export function validateQueryIds(input: unknown): QueryIds {
  const raw = asObject(input)
  const result: QueryIds = {}
  for (const operation of OPERATIONS) {
    const value = string(raw[operation]).trim()
    if (!value) continue
    if (!/^[\w-]{8,80}$/.test(value)) throw new XApiError(`${operation} 查询 ID 格式无效。`)
    result[operation as Operation] = value
  }
  return result
}

export class XClient {
  readonly dispatcher: Dispatcher
  private transactionPromise: Promise<ClientTransaction | null> | null = null
  private constructor(
    private readonly authToken: string,
    private readonly ct0: string,
    private readonly overrides: QueryIds,
    dispatcher: Dispatcher,
  ) {
    this.dispatcher = dispatcher
  }

  static async create(authToken: string, ct0: string, proxy: string, overrides: QueryIds): Promise<XClient> {
    const chosen = proxy.trim()
    if (chosen && !['direct', 'none', '直连'].includes(chosen.toLowerCase())) {
      const url = new URL(/^[a-z]+:\/\//i.test(chosen) ? chosen : `http://${chosen}`)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        throw new XApiError('代理只支持 HTTP 或 HTTPS 地址。')
      }
    }
    const proxyUrl = await resolveProxyUrl(chosen)
    return new XClient(authToken, ct0, overrides, makeDispatcher(proxyUrl))
  }

  async close(): Promise<void> {
    await this.dispatcher.close()
  }

  private headers(json = false): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${BEARER}`,
      'x-csrf-token': this.ct0,
      cookie: `auth_token=${this.authToken}; ct0=${this.ct0}`,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'zh-cn',
      origin: X_ORIGIN,
      referer: `${X_ORIGIN}/`,
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }

  private async transaction(): Promise<ClientTransaction | null> {
    if (!this.transactionPromise) {
      this.transactionPromise = (async () => {
        try {
          const html = await this.text(`${X_ORIGIN}/home`, true)
          const document = parseHTML(html).document as unknown as Document
          const transaction = new ClientTransaction(document)
          // The library fetches its ondemand chunk through global fetch. Route that
          // one fetch through this account's dispatcher so manual/system proxies work.
          const internal = transaction as unknown as {
            getOnDemandFileUrl: (document: Document) => string
            getIndices: (document: Document) => Promise<[number, number[]]>
          }
          internal.getIndices = async (page) => {
            const script = await this.text(internal.getOnDemandFileUrl(page), false)
            const indices = [...script.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)]
              .map((match) => Number(match[1]))
            if (indices.length < 2) throw new Error('X 签名脚本格式已变化。')
            return [indices[0], indices.slice(1)]
          }
          await transaction.initialize()
          return transaction
        } catch {
          // Some X endpoints still work without this header. Let the actual API
          // response decide rather than preventing the entire migration.
          return null
        }
      })()
    }
    return await this.transactionPromise
  }

  private async signedHeaders(method: string, path: string, json = false): Promise<Record<string, string>> {
    const headers = this.headers(json)
    const transaction = await this.transaction()
    if (transaction) {
      try {
        headers['x-client-transaction-id'] = await transaction.generateTransactionId(method, path.split('?')[0])
      } catch { /* The API response will report if a signature is required. */ }
    }
    return headers
  }

  private async json(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const headers = path.startsWith('/i/api/graphql/')
      ? await this.signedHeaders(method, path, body !== undefined)
      : this.headers(body !== undefined)
    const response = await request(`${X_ORIGIN}${path}`, {
      method,
      dispatcher: this.dispatcher,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await response.body.text()
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = {} }
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new XApiError('X 拒绝了会话。请重新复制 auth_token 和 ct0，或确认账号没有被限制。', response.statusCode)
    }
    if (response.statusCode === 429) {
      throw new XApiError('X 接口已限流。请稍后重新扫描或迁移。', 429)
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = safeErrorMessage(parsed)
      throw new XApiError(`X 接口返回 ${response.statusCode}${detail ? `：${detail}` : ''}`, response.statusCode)
    }
    const detail = safeErrorMessage(parsed)
    if (detail) throw new XApiError(`X 接口错误：${detail}`)
    return parsed
  }

  async verify(): Promise<Account> {
    const data = await this.json('GET', '/i/api/1.1/account/verify_credentials.json?include_entities=false&skip_status=true')
    const id = string(asObject(data).id_str) || String(asObject(data).id ?? '')
    const screenName = string(asObject(data).screen_name)
    if (!id || !screenName) throw new XApiError('X 未返回账号身份，请检查会话是否有效。')
    return {
      id,
      screenName,
      name: string(asObject(data).name) || screenName,
      avatarUrl: string(asObject(data).profile_image_url_https) || null,
    }
  }

  private async text(url: string, authenticated: boolean): Promise<string> {
    const response = await request(url, {
      method: 'GET',
      dispatcher: this.dispatcher,
      headers: authenticated ? this.headers() : { accept: '*/*' },
    })
    if (response.statusCode !== 200) {
      await response.body.dump()
      throw new XApiError(`无法读取 X 网页脚本（${response.statusCode}）。`, response.statusCode)
    }
    return await response.body.text()
  }

  private async discover(): Promise<QueryIds> {
    if (Date.now() - discoveredAt < DISCOVERY_TTL) return discoveredIds
    const found: QueryIds = {}
    const html = await this.text(`${X_ORIGIN}/home`, true)
    findOperations(html, found)
    const queue = [...new Set([...scriptUrls(html), ...runtimeChunkUrls(html)])].sort((a, b) => {
      const priority = (url: string) => {
        if (url.includes('shared~bundle.BookmarkFolders~bundle.Bookmarks.')) return 0
        if (/Bookmark|Following/i.test(url)) return 1
        if (/main\./i.test(url)) return 2
        return 3
      }
      return priority(a) - priority(b)
    })
    const seen = new Set<string>()
    while (queue.length > 0 && seen.size < MAX_ASSETS && Object.keys(found).length < OPERATIONS.size) {
      const url = queue.shift()!
      if (seen.has(url)) continue
      seen.add(url)
      try {
        const script = await this.text(url, false)
        findOperations(script, found)
        for (const nested of scriptUrls(script)) if (!seen.has(nested)) queue.push(nested)
      } catch { /* Another bundle may still contain the operation. */ }
    }
    discoveredIds = found
    discoveredAt = Object.keys(found).length ? Date.now() : 0
    return found
  }

  private async operationId(operation: Operation): Promise<string> {
    if (this.overrides[operation]) return this.overrides[operation]!
    const ids = await this.discover()
    const id = ids[operation]
    if (!id) {
      throw new XApiError(`未找到 ${operation} 查询 ID。请在“高级设置”中从 X 网页 Network 请求填入该操作的 ID 后重新连接。`)
    }
    return id
  }

  private async withOperation<T>(operation: Operation, run: (id: string) => Promise<T>): Promise<T> {
    const id = await this.operationId(operation)
    try {
      return await run(id)
    } catch (error) {
      if (this.overrides[operation] || !(error instanceof XApiError) ||
        ![400, 404].includes(error.status ?? 0)) throw error
      discoveredAt = 0
      discoveredIds = {}
      const freshId = await this.operationId(operation)
      if (freshId === id) throw error
      return await run(freshId)
    }
  }

  private async graphqlGet(operation: Operation, variables: JsonObject): Promise<unknown> {
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(graphqlFeatures),
    })
    return await this.withOperation(operation, async (id) =>
      await this.json('GET', `/i/api/graphql/${id}/${operation}?${params}`))
  }

  private async graphqlPost(operation: Operation, variables: JsonObject): Promise<void> {
    await this.withOperation(operation, async (id) => {
      await this.json('POST', `/i/api/graphql/${id}/${operation}`, {
        variables,
        features: {},
        queryId: id,
      })
    })
  }

  private async list(kind: 'following' | 'bookmarks', userId?: string, onPage?: (count: number) => void): Promise<MigrationItem[]> {
    const all: MigrationItem[] = []
    const seenIds = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const variables: JsonObject = kind === 'following'
        ? { userId, count: 100, includePromotedContent: false, withGrokTranslatedBio: true }
        : { count: 20, includePromotedContent: false }
      if (cursor) variables.cursor = cursor
      const body = await this.graphqlGet(kind === 'following' ? 'Following' : 'Bookmarks', variables)
      const result = parseTimeline(body, kind)
      for (const item of result.items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id)
          all.push(item)
        }
      }
      onPage?.(all.length)
      if (!result.cursor) return all
      if (seenCursors.has(result.cursor)) throw new XApiError('X 返回重复分页游标，已停止扫描以避免遗漏数据。')
      seenCursors.add(result.cursor)
      cursor = result.cursor
    }
    throw new XApiError('列表超过 500 页，已停止扫描以避免只迁移部分数据。')
  }

  async following(account: Account, onPage?: (count: number) => void): Promise<MigrationItem[]> {
    return await this.list('following', account.id, onPage)
  }

  async bookmarks(onPage?: (count: number) => void): Promise<MigrationItem[]> {
    return await this.list('bookmarks', undefined, onPage)
  }

  private async friendship(action: 'create' | 'destroy', userId: string): Promise<void> {
    const path = `/i/api/1.1/friendships/${action}.json`
    const response = await request(`${X_ORIGIN}${path}`, {
      method: 'POST',
      dispatcher: this.dispatcher,
      headers: { ...await this.signedHeaders('POST', path), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_id: userId }).toString(),
    })
    const raw = await response.body.text()
    let body: unknown
    try { body = JSON.parse(raw) } catch { body = {} }
    if (response.statusCode === 429) throw new XApiError('X 接口已限流。请稍后继续。', 429)
    if (response.statusCode < 200 || response.statusCode >= 300 || safeErrorMessage(body)) {
      throw new XApiError(`${action === 'create' ? '关注' : '取消关注'}失败（${response.statusCode}）${safeErrorMessage(body) ? `：${safeErrorMessage(body)}` : ''}`, response.statusCode)
    }
  }

  async follow(userId: string): Promise<void> { await this.friendship('create', userId) }
  async unfollow(userId: string): Promise<void> { await this.friendship('destroy', userId) }
  async addBookmark(tweetId: string): Promise<void> { await this.graphqlPost('CreateBookmark', { tweet_id: tweetId }) }
  async removeBookmark(tweetId: string): Promise<void> { await this.graphqlPost('DeleteBookmark', { tweet_id: tweetId }) }
}
