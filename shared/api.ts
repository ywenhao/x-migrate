import { Hono } from 'hono'
import {
  XApiError,
  XClient,
  validateQueryIds,
  validateSessionInput,
  type QueryIds,
} from './x-api.ts'

const MAX_BODY_BYTES = 2 * 1024 * 1024
type Locale = 'en' | 'zh-CN'
export type ClientFactory = (authToken: string, ct0: string, queryIds: QueryIds) => Promise<XClient>

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly englishMessage: string,
  ) {
    super(message)
  }
}

function language(request: Request): Locale {
  return request.headers.get('accept-language')?.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

function errorMessage(error: unknown, locale: Locale): string {
  if (error instanceof ApiError || error instanceof XApiError)
    return locale === 'en' ? error.englishMessage : error.message
  return locale === 'en' ? 'Request failed.' : '请求失败。'
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length'))
  if (length > MAX_BODY_BYTES)
    throw new ApiError('请求内容过大。', 413, 'Request body is too large.')
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('请求 JSON 格式错误。', 400, 'Invalid request JSON.')
  const decoder = new TextDecoder()
  let body = ''
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new ApiError('请求内容过大。', 413, 'Request body is too large.')
    }
    body += decoder.decode(value, { stream: true })
  }
  body += decoder.decode()
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new ApiError('请求 JSON 格式错误。', 400, 'Invalid request JSON.')
  }
}

function requestCredentials(body: Record<string, unknown>) {
  return validateSessionInput(body.authToken, body.ct0)
}

export function createApi(
  createClient: ClientFactory = XClient.create,
  publicOrigin?: string,
): Hono {
  const app = new Hono()
  const allowedOrigin = publicOrigin ? new URL(publicOrigin).origin : null

  app.onError((error, context) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof XApiError
          ? error.status && error.status < 500
            ? error.status
            : error.status
              ? 502
              : 400
          : 500
    context.header('Cache-Control', 'no-store')
    context.header('X-Content-Type-Options', 'nosniff')
    return context.json(
      {
        error: errorMessage(error, language(context.req.raw)),
        ...(error instanceof XApiError && error.status === 429 ? { retryAt: error.retryAt } : {}),
      },
      status as 400,
    )
  })

  app.use('/api/*', async (context, next) => {
    const origin = context.req.header('origin')
    if (origin && origin !== (allowedOrigin || new URL(context.req.url).origin))
      throw new ApiError(
        '不接受其他网站发起的请求。',
        403,
        'Requests from other sites are not accepted.',
      )
    context.header('Cache-Control', 'no-store')
    context.header('X-Content-Type-Options', 'nosniff')
    await next()
  })

  app.get('/api/health', (context) => context.json({ ok: true }))

  app.post('/api/connect', async (context) => {
    const body = await readBody(context.req.raw)
    const { authToken, ct0 } = requestCredentials(body)
    const client = await createClient(authToken, ct0, validateQueryIds(body.queryIds))
    try {
      return context.json({ account: await client.verify() })
    } finally {
      await client.close()
    }
  })

  app.post('/api/page', async (context) => {
    const body = await readBody(context.req.raw)
    const { authToken, ct0 } = requestCredentials(body)
    const kind = body.kind
    if (kind !== 'following' && kind !== 'bookmarks')
      throw new ApiError('列表类型无效。', 400, 'Invalid list kind.')
    const userId = kind === 'following' ? body.userId : undefined
    if (kind === 'following' && (typeof userId !== 'string' || !/^\d{1,25}$/.test(userId)))
      throw new ApiError('账号 ID 无效。', 400, 'Invalid account ID.')
    const cursor = body.cursor == null ? null : body.cursor
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048))
      throw new ApiError('分页游标无效。', 400, 'Invalid page cursor.')
    const client = await createClient(authToken, ct0, validateQueryIds(body.queryIds))
    try {
      return context.json(
        await client.page(kind, userId as string | undefined, cursor as string | null),
      )
    } finally {
      await client.close()
    }
  })

  app.post('/api/action', async (context) => {
    const body = await readBody(context.req.raw)
    const { authToken, ct0 } = requestCredentials(body)
    const action = body.action
    const id = body.id
    if (
      typeof id !== 'string' ||
      !/^\d{1,25}$/.test(id) ||
      !['follow', 'unfollow', 'addBookmark', 'removeBookmark'].includes(String(action))
    )
      throw new ApiError('操作无效。', 400, 'Invalid action.')
    const client = await createClient(authToken, ct0, validateQueryIds(body.queryIds))
    try {
      if (action === 'follow') await client.follow(id)
      else if (action === 'unfollow') await client.unfollow(id)
      else if (action === 'addBookmark') await client.addBookmark(id)
      else await client.removeBookmark(id)
      return context.json({ ok: true })
    } finally {
      await client.close()
    }
  })

  app.all('/api/*', (context) =>
    context.json(
      { error: language(context.req.raw) === 'en' ? 'API route not found.' : '接口不存在。' },
      404,
    ),
  )
  return app
}
