import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { JobProgress, JobStage, JobView, ItemsPage, MigrationKind, ScanListProgress } from '../src/types.ts'
import { XApiError, XClient, validateQueryIds, validateSessionInput, type Account, type MigrationItem } from './x-api.ts'

const SESSION_TTL = 3 * 60 * 60 * 1000
const JOB_TTL = 12 * 60 * 60 * 1000
const WRITE_DELAY = 900
const FALLBACK_RATE_WAIT = 15 * 60 * 1000
const MAX_BODY = 2 * 1024 * 1024

interface Session {
  id: string
  client: XClient
  account: Account
  touchedAt: number
}

interface KindData {
  source: MigrationItem[]
  targetIds: Set<string>
  initialTargetIds: Set<string>
}

interface Job {
  id: string
  sourceSession: string
  targetSession: string
  source: Account
  target: Account
  selected: Record<MigrationKind, boolean>
  selectedItemIds: Record<MigrationKind, string[]>
  scanProgress: JobView['scanProgress']
  removeSource: Record<MigrationKind, boolean>
  data: Record<MigrationKind, KindData>
  stage: JobStage
  message: string
  progress: JobProgress
  retryAt: number | null
  resumeTimer: ReturnType<typeof setTimeout> | null
  wakeResume: (() => void) | null
  errors: string[]
  cancelled: boolean
  scanAbort: AbortController | null
  touchedAt: number
}

const sessions = new Map<string, Session>()
const jobs = new Map<string, Job>()
let activeJobId: string | null = null

function emptyData(): KindData {
  return { source: [], targetIds: new Set(), initialTargetIds: new Set() }
}

function emptyScanList(total: number | null = null): JobView['scanProgress']['following']['source'] {
  return { read: 0, total, page: 0, done: false }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(body))
}

function fail(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : '发生未知错误。'
  const status = error instanceof HttpError ? error.status : error instanceof XApiError && error.status === 429 ? 429 : 400
  respond(response, status, { error: message })
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += chunk.toString('utf8')
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new HttpError('请求内容过大。', 413)
  }
  if (!body) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError('请求 JSON 格式错误。', 400)
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(`缺少 ${name}。`, 400)
  return value.trim()
}

function requireSelectedIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !/^\d{1,25}$/.test(id))) {
    throw new HttpError(`${label}勾选项格式错误。`, 400)
  }
  return [...new Set(value as string[])]
}

function getSession(id: unknown): Session {
  const session = sessions.get(requireText(id, '会话 ID'))
  if (!session) throw new HttpError('会话已失效，请重新连接账号。', 404)
  session.touchedAt = Date.now()
  return session
}

function getJob(id: string): Job {
  const job = jobs.get(id)
  if (!job) throw new HttpError('任务不存在或已过期，请重新扫描。', 404)
  job.touchedAt = Date.now()
  return job
}

function snapshot(job: Job): JobView {
  const summary = (kind: MigrationKind) => {
    const data = job.data[kind]
    const alreadyThere = data.source.filter((item) => data.initialTargetIds.has(item.id)).length
    return {
      source: data.source.length,
      alreadyThere,
      toCopy: data.source.length - alreadyThere,
    }
  }
  return {
    id: job.id,
    stage: job.stage,
    message: job.message,
    source: job.source,
    target: job.target,
    selected: job.selected,
    scanProgress: job.scanProgress,
    summary: { following: summary('following'), bookmarks: summary('bookmarks') },
    progress: job.progress,
    retryAt: job.retryAt,
    errors: job.errors.slice(-30),
    removeSource: job.removeSource,
  }
}

function itemsPage(job: Job, kind: MigrationKind, offset: number): ItemsPage {
  const limit = 30
  const data = job.data[kind]
  return {
    items: data.source.slice(offset, offset + limit).map((item) => ({
      ...item,
      alreadyThere: data.initialTargetIds.has(item.id),
    })),
    total: data.source.length,
    offset,
    limit,
  }
}

function cancelCheck(job: Job): boolean {
  if (!job.cancelled) return false
  job.stage = 'cancelled'
  job.message = '任务已停止。已完成的 X 操作不会撤销。'
  return true
}

function jobError(job: Job, error: unknown): void {
  job.stage = 'failed'
  job.message = error instanceof Error ? error.message : '任务失败。'
  job.errors.push(job.message)
}

async function scan(job: Job, source: Session, target: Session): Promise<void> {
  const signal = job.scanAbort!.signal
  let reading = ''
  try {
    for (const kind of ['following', 'bookmarks'] as const) {
      if (!job.selected[kind]) continue
      if (cancelCheck(job)) return
      const label = kind === 'following' ? '关注' : '收藏'
      const report = (side: '旧' | '新', progress: ScanListProgress) =>
        (count: number, page: number, inferredEnd: boolean) => {
          progress.read = count
          progress.page = page
          job.message = `已读取${side}账号${label} ${count} 项（第 ${page} 页）…`
          if (inferredEnd) {
            job.errors.push(`${side}账号${label}列表连续无新增项目，已按列表末尾处理（${count} 项）。请核对数量。`)
          }
        }
      reading = `旧账号${label}`
      job.message = `正在读取旧账号${label}…`
      const sourceProgress = job.scanProgress[kind].source
      const sourceItems = kind === 'following'
        ? await source.client.following(source.account, report('旧', sourceProgress), signal)
        : await source.client.bookmarks(report('旧', sourceProgress), signal)
      job.data[kind].source = sourceItems
      sourceProgress.read = sourceItems.length
      sourceProgress.total ??= sourceItems.length
      sourceProgress.done = true
      if (cancelCheck(job)) return
      reading = `新账号${label}`
      job.message = `正在读取新账号${label}，用于跳过已有内容…`
      const targetProgress = job.scanProgress[kind].target
      const targetItems = kind === 'following'
        ? await target.client.following(target.account, report('新', targetProgress), signal)
        : await target.client.bookmarks(report('新', targetProgress), signal)
      job.data[kind].targetIds = new Set(targetItems.map((item) => item.id))
      job.data[kind].initialTargetIds = new Set(job.data[kind].targetIds)
      targetProgress.read = targetItems.length
      targetProgress.total ??= targetItems.length
      targetProgress.done = true
    }
    if (cancelCheck(job)) return
    job.stage = 'ready'
    job.message = job.errors.length
      ? '扫描已结束。部分列表因连续无新增项目按末尾处理，请核对数量和预览。'
      : '扫描完成。请核对数量和预览，再决定是否开始迁移。'
  } catch (error) {
    if (!cancelCheck(job)) {
      const message = error instanceof Error ? error.message : '任务失败。'
      jobError(job, new Error(reading ? `${reading}：${message}` : message))
    }
  } finally {
    job.scanAbort = null
    if (activeJobId === job.id) activeJobId = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pauseForRateLimit(job: Job, error: XApiError): Promise<boolean> {
  const now = Date.now()
  job.retryAt = Math.max(now + 5_000, Math.min(error.retryAt ?? now + FALLBACK_RATE_WAIT, now + 60 * 60 * 1000))
  job.stage = 'paused'
  job.message = `X 接口限流，预计 ${new Date(job.retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 自动继续。`
  await new Promise<void>((resolve) => {
    job.wakeResume = resolve
    job.resumeTimer = setTimeout(resolve, Math.max(0, job.retryAt! - Date.now()))
  })
  if (job.resumeTimer) clearTimeout(job.resumeTimer)
  job.resumeTimer = null
  job.wakeResume = null
  job.retryAt = null
  if (cancelCheck(job)) return false
  job.stage = 'running'
  job.message = '继续迁移…'
  return true
}

async function runMigration(job: Job, source: Session, target: Session): Promise<void> {
  try {
    for (const kind of ['following', 'bookmarks'] as const) {
      if (!job.selected[kind]) continue
      const data = job.data[kind]
      const items = new Map(data.source.map((item) => [item.id, item]))
      for (const id of job.selectedItemIds[kind]) {
        const item = items.get(id)
        if (!item) throw new Error('勾选项不在扫描结果中，请重新扫描。')
        if (cancelCheck(job)) return
        let targetReady = data.targetIds.has(id)
        if (targetReady) job.progress.alreadyThere++
        while (true) {
          if (cancelCheck(job)) return
          job.message = `正在处理${kind === 'following' ? '关注' : '收藏'} ${job.progress.processed + 1} / ${job.progress.total}`
          try {
            if (!targetReady) {
              if (kind === 'following') await target.client.follow(id)
              else await target.client.addBookmark(id)
              targetReady = true
              data.targetIds.add(id)
              job.progress.copied++
              await delay(WRITE_DELAY)
            }
            if (cancelCheck(job)) return
            // Only a selected item confirmed on the target may be removed.
            if (job.removeSource[kind]) {
              if (kind === 'following') await source.client.unfollow(id)
              else await source.client.removeBookmark(id)
              job.progress.removed++
              await delay(WRITE_DELAY)
            }
            job.progress.processed++
            break
          } catch (error) {
            if (error instanceof XApiError && error.status === 429) {
              if (!await pauseForRateLimit(job, error)) return
              continue
            }
            job.progress.failed++
            job.progress.processed++
            const reason = error instanceof Error ? error.message : '未知错误'
            if (job.errors.length < 100) job.errors.push(`${item.detail}：${reason}`)
            break
          }
        }
      }
    }
    job.stage = 'completed'
    job.message = job.progress.failed
      ? '迁移结束，部分项目失败。请查看记录，稍后重新扫描并重试。'
      : '迁移完成。'
  } catch (error) {
    if (!cancelCheck(job)) jobError(job, error)
  } finally {
    if (job.resumeTimer) clearTimeout(job.resumeTimer)
    job.resumeTimer = null
    job.wakeResume = null
    job.retryAt = null
    if (activeJobId === job.id) activeJobId = null
  }
}

function prune(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (id !== activeJobId && now - job.touchedAt > JOB_TTL) jobs.delete(id)
  }
  for (const [id, session] of sessions) {
    const inUse = [...jobs.values()].some((job) =>
      (job.stage === 'scanning' || job.stage === 'running' || job.stage === 'paused') &&
      (job.sourceSession === id || job.targetSession === id))
    if (!inUse && now - session.touchedAt > SESSION_TTL) {
      sessions.delete(id)
      void session.client.close()
    }
  }
}

function checkOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin
  if (!origin) return
  try {
    const source = new URL(origin)
    const publicOrigin = process.env.X_MIGRATE_APP_ORIGIN
    if (publicOrigin && source.origin === new URL(publicOrigin).origin) return
    if (source.host === request.headers.host &&
      ['http:', 'https:'].includes(source.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) return
  } catch { /* Treat malformed Origin as foreign. */ }
  throw new HttpError('不接受其他网站发起的请求。', 403)
}

function checkProxySecret(request: IncomingMessage): void {
  const expected = process.env.X_MIGRATE_PROXY_SECRET
  const actual = request.headers['x-x-migrate-proxy-key']
  if (!expected || typeof actual !== 'string') throw new HttpError('请求未通过代理认证。', 403)
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new HttpError('请求未通过代理认证。', 403)
  }
}

async function handle(request: IncomingMessage, response: ServerResponse, requireProxySecret = false): Promise<void> {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/api/')) throw new HttpError('接口不存在。', 404)
    if (requireProxySecret) checkProxySecret(request)
    checkOrigin(request)
    prune()
    const method = request.method || 'GET'
    if (method === 'GET' && url.pathname === '/api/health') {
      respond(response, 200, { ok: true })
      return
    }
    if (method === 'POST' && url.pathname === '/api/connect') {
      const body = await readBody(request)
      const { authToken, ct0 } = validateSessionInput(body.authToken, body.ct0)
      const proxy = typeof body.proxy === 'string' ? body.proxy : ''
      const client = await XClient.create(authToken, ct0, proxy, validateQueryIds(body.queryIds))
      try {
        const account = await client.verify()
        const id = randomUUID()
        sessions.set(id, { id, client, account, touchedAt: Date.now() })
        respond(response, 200, { sessionId: id, account })
      } catch (error) {
        await client.close()
        throw error
      }
      return
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f\d-]{36})$/)
    if (method === 'GET' && sessionMatch) {
      const session = getSession(sessionMatch[1])
      respond(response, 200, { sessionId: session.id, account: session.account })
      return
    }

    if (method === 'POST' && url.pathname === '/api/disconnect') {
      const body = await readBody(request)
      const session = getSession(body.sessionId)
      const busy = [...jobs.values()].some((job) =>
        (job.stage === 'scanning' || job.stage === 'running' || job.stage === 'paused') &&
        (job.sourceSession === session.id || job.targetSession === session.id))
      if (busy) throw new HttpError('请先停止正在执行的任务。', 409)
      sessions.delete(session.id)
      await session.client.close()
      respond(response, 200, { ok: true })
      return
    }

    if (method === 'POST' && url.pathname === '/api/scan') {
      if (activeJobId) throw new HttpError('已有任务正在执行，请等待或停止它。', 409)
      const body = await readBody(request)
      const source = getSession(body.sourceSessionId)
      const target = getSession(body.targetSessionId)
      if (source.id === target.id || source.account.id === target.account.id) {
        throw new HttpError('旧账号和新账号必须是两个不同的 X 账号。', 400)
      }
      const selected = {
        following: body.following === true,
        bookmarks: body.bookmarks === true,
      }
      if (!selected.following && !selected.bookmarks) throw new HttpError('请至少选择一项迁移内容。', 400)
      const job: Job = {
        id: randomUUID(),
        sourceSession: source.id,
        targetSession: target.id,
        source: source.account,
        target: target.account,
        selected,
        selectedItemIds: { following: [], bookmarks: [] },
        scanProgress: {
          following: {
            source: emptyScanList(source.account.followingCount ?? null),
            target: emptyScanList(target.account.followingCount ?? null),
          },
          bookmarks: { source: emptyScanList(), target: emptyScanList() },
        },
        removeSource: { following: false, bookmarks: false },
        data: { following: emptyData(), bookmarks: emptyData() },
        stage: 'scanning',
        message: '准备扫描…',
        progress: { processed: 0, total: 0, copied: 0, alreadyThere: 0, removed: 0, failed: 0 },
        retryAt: null,
        resumeTimer: null,
        wakeResume: null,
        errors: [],
        cancelled: false,
        scanAbort: new AbortController(),
        touchedAt: Date.now(),
      }
      jobs.set(job.id, job)
      activeJobId = job.id
      void scan(job, source, target)
      respond(response, 202, { job: snapshot(job) })
      return
    }

    const match = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})(?:\/(items|start|cancel|resume))?$/)
    if (match) {
      const job = getJob(match[1])
      const action = match[2] || ''
      if (method === 'GET' && !action) {
        respond(response, 200, { job: snapshot(job) })
        return
      }
      if (method === 'GET' && action === 'items') {
        if (job.stage === 'scanning') throw new HttpError('扫描尚未完成。', 409)
        const kind = url.searchParams.get('kind')
        if (kind !== 'following' && kind !== 'bookmarks') throw new HttpError('无效的列表类型。', 400)
        const rawOffset = Number(url.searchParams.get('offset') ?? '0')
        if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) throw new HttpError('无效的分页位置。', 400)
        respond(response, 200, itemsPage(job, kind, rawOffset))
        return
      }
      if (method === 'POST' && action === 'cancel') {
        if (job.stage === 'scanning') {
          job.cancelled = true
          cancelCheck(job)
          job.scanAbort?.abort()
        } else if (job.stage === 'running') {
          job.cancelled = true
          job.message = '正在停止，等待当前 X 操作结束…'
        } else if (job.stage === 'paused') {
          job.cancelled = true
          cancelCheck(job)
          job.retryAt = null
          job.wakeResume?.()
        } else if (job.stage === 'ready') {
          job.cancelled = true
          cancelCheck(job)
        }
        respond(response, 200, { job: snapshot(job) })
        return
      }
      if (method === 'POST' && action === 'resume') {
        if (job.stage !== 'paused') throw new HttpError('任务当前没有暂停。', 409)
        job.stage = 'running'
        job.retryAt = null
        job.message = '手动继续迁移…'
        job.wakeResume?.()
        respond(response, 200, { job: snapshot(job) })
        return
      }
      if (method === 'POST' && action === 'start') {
        if (activeJobId) throw new HttpError('已有任务正在执行。', 409)
        if (job.stage !== 'ready') throw new HttpError('请先完成扫描，且每个任务只能执行一次。', 409)
        const source = getSession(job.sourceSession)
        const target = getSession(job.targetSession)
        const body = await readBody(request)
        const selectedItemIds = {
          following: requireSelectedIds(body.followingIds, '关注'),
          bookmarks: requireSelectedIds(body.bookmarkIds, '收藏'),
        }
        for (const kind of ['following', 'bookmarks'] as const) {
          if (!job.selected[kind] && selectedItemIds[kind].length) throw new HttpError('勾选项不属于本次扫描内容。', 400)
          const available = new Set(job.data[kind].source
            .filter((item) => !job.data[kind].initialTargetIds.has(item.id))
            .map((item) => item.id))
          if (selectedItemIds[kind].some((id) => !available.has(id))) {
            throw new HttpError('勾选项不存在或新账号已经拥有，请重新扫描。', 400)
          }
        }
        const totalSelected = selectedItemIds.following.length + selectedItemIds.bookmarks.length
        if (!totalSelected) throw new HttpError('请至少勾选一项待迁移内容。', 400)
        const removeSource = {
          following: job.selected.following && body.removeFollowing === true,
          bookmarks: job.selected.bookmarks && body.removeBookmarks === true,
        }
        if ((removeSource.following || removeSource.bookmarks) &&
          body.removeConfirmation !== `@${job.source.screenName}`) {
          throw new HttpError(`移除旧账号内容前，请输入 @${job.source.screenName} 确认。`, 400)
        }
        job.selectedItemIds = selectedItemIds
        job.removeSource = removeSource
        job.progress.total = totalSelected
        job.stage = 'running'
        job.message = '开始迁移…'
        activeJobId = job.id
        void runMigration(job, source, target)
        respond(response, 202, { job: snapshot(job) })
        return
      }
    }
    throw new HttpError('接口不存在。', 404)
  } catch (error) {
    fail(response, error)
  }
}

export function xApiNodeHandler(request: IncomingMessage, response: ServerResponse): void {
  void handle(request, response, true)
}

export function xApiPlugin(): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith('/api/')) return next()
    void handle(request, response)
  }
  return {
    name: 'x-migrate-api',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
