import { Hono } from 'hono'
import { XApiError, XClient, validateQueryIds, validateSessionInput, type Operation } from './x-api.ts'

export type WorkerBindings = { ASSETS: { fetch(request: Request): Promise<Response> } }

type Locale = 'en' | 'zh-CN'
function locale(request: Request): Locale {
  return request.headers.get('accept-language')?.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}
function message(error: unknown, lang: Locale): string {
  if (error instanceof XApiError) return lang === 'en' ? error.englishMessage : error.message
  return error instanceof Error ? error.message : 'Request failed.'
}
function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON body.')
  return value as Record<string, unknown>
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try { return bodyObject(await request.json()) } catch { throw new Error('Invalid request JSON.') }
}
function credentials(body: Record<string, unknown>) {
  return validateSessionInput(body.authToken, body.ct0)
}

const app = new Hono<{ Bindings: WorkerBindings }>()
app.onError((error, c) => {
  const status = error instanceof XApiError && error.status ? error.status : 400
  return c.json({ error: message(error, locale(c)) }, status as 400 | 401 | 403 | 429 | 500)
})
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.req.url).origin)
    return c.json({ error: locale(c) === 'en' ? 'Requests from other sites are not accepted.' : '不接受其他网站发起的请求。' }, 403)
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
})

app.get('/api/health', (c) => c.json({ ok: true }))

app.post('/api/connect', async (c) => {
  const body = await jsonBody(c.req.raw)
  const { authToken, ct0 } = credentials(body)
  const queryIds = validateQueryIds(body.queryIds)
  const client = await XClient.create(authToken, ct0, '', queryIds)
  try { return c.json({ account: await client.verify() }) }
  finally { await client.close() }
})

app.post('/api/page', async (c) => {
  const body = await jsonBody(c.req.raw)
  const { authToken, ct0 } = credentials(body)
  const kind = body.kind === 'following' || body.kind === 'bookmarks' ? body.kind : null
  if (!kind) return c.json({ error: 'Invalid list kind.' }, 400)
  const cursor = typeof body.cursor === 'string' ? body.cursor : null
  const client = await XClient.create(authToken, ct0, '', validateQueryIds(body.queryIds))
  try {
    const account = kind === 'following' ? String(body.userId || '') : undefined
    return c.json(await client.page(kind, account, cursor))
  } catch (error) {
    const status = error instanceof XApiError && error.status ? error.status : 400
    return c.json({ error: message(error, locale(c)) }, status as 400 | 401 | 403 | 429 | 500)
  } finally { await client.close() }
})

app.post('/api/action', async (c) => {
  const body = await jsonBody(c.req.raw)
  const { authToken, ct0 } = credentials(body)
  const action = typeof body.action === 'string' ? body.action : ''
  const id = typeof body.id === 'string' ? body.id : ''
  if (!/^\\d{1,25}$/.test(id) || !['follow','unfollow','addBookmark','removeBookmark'].includes(action))
    return c.json({ error: 'Invalid action.' }, 400)
  const client = await XClient.create(authToken, ct0, '', validateQueryIds(body.queryIds))
  try {
    if (action === 'follow') await client.follow(id)
    else if (action === 'unfollow') await client.unfollow(id)
    else if (action === 'addBookmark') await client.addBookmark(id)
    else await client.removeBookmark(id)
    return c.json({ ok: true })
  } catch (error) {
    const status = error instanceof XApiError && error.status ? error.status : 400
    return c.json({ error: message(error, locale(c)) }, status as 400 | 401 | 403 | 429 | 500)
  } finally { await client.close() }
})

export default app
