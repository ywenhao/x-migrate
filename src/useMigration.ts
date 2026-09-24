import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { cookiesFromCurl } from './curl'
import { saveLocale, type Locale } from './i18n'
import type { AccountView, ItemView, JobView, MigrationKind, ScanListProgress } from './types'

export function useMigration() {
  const { locale, t } = useI18n()
  type Role = 'source' | 'target'
  interface Credentials { authToken: string; ct0: string }
  interface Connection { sessionId: string; account: AccountView }
  const STORAGE_KEY = 'x-migrate.browser.v2'
  const credentials = reactive<Record<Role, Credentials>>({ source: { authToken: '', ct0: '' }, target: { authToken: '', ct0: '' } })
  const connections = reactive<Record<Role, Connection | null>>({ source: null, target: null })
  const curlInput = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlMessage = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlInvalid = reactive<Record<Role, boolean>>({ source: false, target: false })
  const connecting = ref<Role | null>(null)
  const proxy = ref('')
  const queryIds = reactive({ Viewer: '', UserByScreenName: '', Following: '', Bookmarks: '', CreateBookmark: '', DeleteBookmark: '' })
  const selected = reactive({ following: true, bookmarks: true })
  const removeSource = reactive({ following: false, bookmarks: false })
  const removeConfirmation = ref('')
  const job = ref<JobView | null>(null)
  const previewKind = ref<MigrationKind>('following')
  const previewItems = reactive<Record<MigrationKind, ItemView[]>>({ following: [], bookmarks: [] })
  const chosenIds = reactive<Record<MigrationKind, Set<string>>>({ following: new Set(), bookmarks: new Set() })
  const loadingItems = reactive({ following: false, bookmarks: false })
  const busy = ref(false)
  const error = ref('')
  const clockNow = ref(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null
  let cancelled = false

  const bothConnected = computed(() => !!connections.source && !!connections.target)
  const sameAccount = computed(() => !!connections.source && !!connections.target && connections.source.account.id === connections.target.account.id)
  const taskActive = computed(() => ['scanning', 'running', 'paused'].includes(job.value?.stage || ''))
  const chosenCount = computed(() => chosenIds.following.size + chosenIds.bookmarks.size)
  const previewComplete = computed(() => !job.value || (['following', 'bookmarks'] as const).every((kind) => !job.value?.selected[kind] || previewItems[kind].length === job.value.summary[kind].source))
  const wantsRemoval = computed(() => removeSource.following || removeSource.bookmarks)
  const removalConfirmed = computed(() => !wantsRemoval.value || removeConfirmation.value === `@${job.value?.source.screenName ?? ''}`)
  const selectionMatchesJob = computed(() => !!job.value && selected.following === job.value.selected.following && selected.bookmarks === job.value.selected.bookmarks)
  const percentage = computed(() => job.value?.progress.total ? Math.round((job.value.progress.processed / job.value.progress.total) * 100) : 0)
  const retryCountdown = computed(() => { const n = Math.max(0, Math.ceil(((job.value?.retryAt ?? 0) - clockNow.value) / 1000)); return t('minutesSeconds', { minutes: Math.floor(n / 60), seconds: n % 60 }) })

  function persist(): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ credentials, connections, queryIds, selected, removeSource, job: job.value, previewItems, chosenIds: { following: [...chosenIds.following], bookmarks: [...chosenIds.bookmarks] } }))
    } catch { /* Storage is optional. */ }
  }
  function restore(): boolean {
    try {
      const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as any
      if (!raw) return false
      for (const role of ['source', 'target'] as const) {
        if (raw.credentials?.[role]) Object.assign(credentials[role], raw.credentials[role])
        if (raw.connections?.[role]) connections[role] = raw.connections[role]
      }
      if (raw.queryIds) Object.assign(queryIds, raw.queryIds)
      if (raw.selected) Object.assign(selected, raw.selected)
      if (raw.removeSource) Object.assign(removeSource, raw.removeSource)
      if (raw.job) job.value = raw.job
      if (raw.previewItems) {
        previewItems.following = raw.previewItems.following || []
        previewItems.bookmarks = raw.previewItems.bookmarks || []
      }
      if (raw.chosenIds) {
        chosenIds.following = new Set(raw.chosenIds.following || [])
        chosenIds.bookmarks = new Set(raw.chosenIds.bookmarks || [])
      }
      if (job.value) previewKind.value = job.value.selected.following ? 'following' : 'bookmarks'
      return true
    } catch { return false }
  }
  function showError(cause: unknown): void { error.value = cause instanceof Error ? cause.message : t('unknownError') }
  function parseCurl(role: Role): boolean {
    const cookies = cookiesFromCurl(curlInput[role])
    credentials[role].authToken = ''; credentials[role].ct0 = ''
    if (!cookies) { curlInvalid[role] = true; curlMessage[role] = 'curlInvalid'; return false }
    credentials[role].authToken = cookies.authToken; credentials[role].ct0 = cookies.ct0
    curlInput[role] = ''; curlInvalid[role] = false; curlMessage[role] = 'curlParsed'; return true
  }
  async function api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'accept-language': locale.value, 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
    const data = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(data.error || t('requestFailed', { status: response.status }))
    return data
  }
  async function withCredentials<T>(role: Role, path: string, body: Record<string, unknown> = {}): Promise<T> {
    return api<T>(path, { ...body, authToken: credentials[role].authToken, ct0: credentials[role].ct0, queryIds })
  }
  async function connect(role: Role): Promise<void> {
    error.value = ''
    if (curlInput[role].trim() && !parseCurl(role)) return
    if (!credentials[role].authToken || !credentials[role].ct0) { showError(new Error(t('requestFailed', { status: 400 }))); return }
    connecting.value = role
    try {
      const data = await withCredentials<{ account: AccountView }>(role, '/connect')
      connections[role] = { sessionId: crypto.randomUUID(), account: data.account }
      job.value = null; previewItems.following = []; previewItems.bookmarks = []; chosenIds.following.clear(); chosenIds.bookmarks.clear()
      persist()
    } catch (cause) { showError(cause) } finally { connecting.value = null }
  }
  async function disconnect(role: Role): Promise<void> {
    connections[role] = null; job.value = null; previewItems.following = []; previewItems.bookmarks = []; chosenIds.following.clear(); chosenIds.bookmarks.clear(); persist()
  }
  function scanCount(progress: ScanListProgress): string { return `${progress.read} / ${progress.total ?? t('afterScan')}` }
  function makeProgress(total: number | null = null): ScanListProgress { return { read: 0, total, page: 0, done: false } }
  function newJob(): JobView {
    return {
      id: crypto.randomUUID(), stage: 'scanning', message: t('scanning'),
      source: connections.source!.account, target: connections.target!.account,
      selected: { following: selected.following, bookmarks: selected.bookmarks },
      scanProgress: { following: { source: makeProgress(connections.source!.account.followingCount), target: makeProgress(null) }, bookmarks: { source: makeProgress(null), target: makeProgress(null) } },
      summary: { following: { source: 0, alreadyThere: 0, toCopy: 0 }, bookmarks: { source: 0, alreadyThere: 0, toCopy: 0 } },
      progress: { processed: 0, total: 0, copied: 0, alreadyThere: 0, removed: 0, failed: 0 }, retryAt: null, errors: [], removeSource: { following: false, bookmarks: false },
    }
  }
  async function scanList(role: Role, kind: MigrationKind, userId?: string): Promise<ItemView[]> {
    const items: ItemView[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let page = 1; page <= 500; page++) {
      if (cancelled) throw new Error(t('unknownError'))
      const data = await withCredentials<{ items: ItemView[]; cursor: string | null }>(role, '/page', { kind, userId, cursor })
      for (const item of data.items) if (!seen.has(item.id)) { seen.add(item.id); items.push({ ...item, alreadyThere: false }) }
      const progress = job.value!.scanProgress[kind][role]
      progress.read = items.length; progress.page = page
      if (!data.cursor) break
      if (data.items.length === 0) break
      cursor = data.cursor
      if (page === 500) throw new Error('The list exceeds 500 pages.')
    }
    return items
  }
  async function scan(): Promise<void> {
    if (!connections.source || !connections.target || sameAccount.value || taskActive.value) return
    error.value = ''; busy.value = true; cancelled = false
    removeSource.following = false; removeSource.bookmarks = false; removeConfirmation.value = ''
    chosenIds.following.clear(); chosenIds.bookmarks.clear(); previewItems.following = []; previewItems.bookmarks = []
    job.value = newJob(); persist()
    try {
      for (const kind of ['following', 'bookmarks'] as const) {
        if (!selected[kind]) continue
        job.value.message = `${kind === 'following' ? '正在读取旧账号关注…' : '正在读取旧账号收藏…'}`; persist()
        const source = await scanList('source', kind, kind === 'following' ? connections.source.account.id : undefined)
        if (cancelled) return
        job.value.message = `${kind === 'following' ? '正在读取新账号关注…' : '正在读取新账号收藏…'}`
        const target = await scanList('target', kind, kind === 'following' ? connections.target.account.id : undefined)
        const targetIds = new Set(target.map((item) => item.id))
        source.forEach((item) => { item.alreadyThere = targetIds.has(item.id) })
        previewItems[kind] = source
        job.value.summary[kind] = { source: source.length, alreadyThere: source.filter((x) => x.alreadyThere).length, toCopy: source.filter((x) => !x.alreadyThere).length }
        job.value.scanProgress[kind].source.total = source.length; job.value.scanProgress[kind].source.done = true
        job.value.scanProgress[kind].target.total = target.length; job.value.scanProgress[kind].target.done = true
        persist()
      }
      job.value.stage = 'ready'; job.value.message = t('scanComplete'); persist()
      previewKind.value = selected.following ? 'following' : 'bookmarks'
    } catch (cause) {
      job.value.stage = 'failed'; job.value.message = cause instanceof Error ? cause.message : t('unknownError'); showError(cause); persist()
    } finally { busy.value = false }
  }
  function availableItems(kind: MigrationKind): ItemView[] { return previewItems[kind].filter((item) => !item.alreadyThere) }
  function allChosen(kind: MigrationKind): boolean { const items = availableItems(kind); return items.length > 0 && items.every((item) => chosenIds[kind].has(item.id)) }
  function toggleAll(kind: MigrationKind): void { if (job.value?.stage !== 'ready') return; const clear = allChosen(kind); for (const item of availableItems(kind)) clear ? chosenIds[kind].delete(item.id) : chosenIds[kind].add(item.id); persist() }
  function toggleItem(kind: MigrationKind, id: string): void { if (job.value?.stage !== 'ready' || !availableItems(kind).some((x) => x.id === id)) return; chosenIds[kind].has(id) ? chosenIds[kind].delete(id) : chosenIds[kind].add(id); persist() }
  async function action(role: Role, kind: MigrationKind, id: string, remove = false): Promise<void> {
    const name = kind === 'following' ? (remove ? 'unfollow' : 'follow') : (remove ? 'removeBookmark' : 'addBookmark')
    await withCredentials(role, '/action', { action: name, id })
  }
  function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
  async function begin(): Promise<void> {
    if (!job.value || !chosenCount.value || !previewComplete.value || !removalConfirmed.value || !selectionMatchesJob.value || !connections.source || !connections.target) return
    error.value = ''; busy.value = true; cancelled = false
    job.value.stage = 'running'; job.value.progress = { processed: 0, total: chosenCount.value, copied: 0, alreadyThere: 0, removed: 0, failed: 0 }; persist()
    try {
      for (const kind of ['following', 'bookmarks'] as const) {
        if (!job.value.selected[kind]) continue
        for (const item of previewItems[kind]) {
          if (!chosenIds[kind].has(item.id)) continue
          if (cancelled) throw new Error('Migration stopped.')
          if (item.alreadyThere) job.value.progress.alreadyThere++
          else {
            while (true) {
              try { await action('target', kind, item.id); break }
              catch (cause) {
                if (!(cause instanceof Error) || !/429|rate limit|限流/i.test(cause.message)) throw cause
                job.value.stage = 'paused'; job.value.retryAt = Date.now() + 60_000; persist(); await delay(60_000); job.value.stage = 'running'; job.value.retryAt = null
              }
            }
            job.value.progress.copied++; item.alreadyThere = true; await delay(900)
          }
          if (removeSource[kind]) { await action('source', kind, item.id, true); job.value.progress.removed++; await delay(900) }
          job.value.progress.processed++; persist()
        }
      }
      job.value.stage = 'completed'; job.value.message = job.value.progress.failed ? '迁移结束，部分项目失败。' : '迁移完成。'; persist()
    } catch (cause) {
      if (cancelled) { job.value.stage = 'cancelled'; job.value.message = '任务已停止。' }
      else { job.value.stage = 'failed'; job.value.message = cause instanceof Error ? cause.message : t('unknownError'); showError(cause) }
      persist()
    } finally { busy.value = false }
  }
  async function cancel(): Promise<void> { cancelled = true; if (job.value && ['scanning','running','paused'].includes(job.value.stage)) { job.value.stage = 'cancelled'; job.value.message = '任务已停止。'; persist() } }
  async function resume(): Promise<void> { if (job.value?.stage !== 'paused') return; await begin() }
  function setLocale(next: Locale): void { locale.value = next; saveLocale(next) }
  onMounted(() => { restore(); clockTimer = setInterval(() => { clockNow.value = Date.now() }, 1000) })
  onUnmounted(() => { if (clockTimer) clearInterval(clockTimer) })
  return { t, locale, setLocale, credentials, curlInput, curlMessage, curlInvalid, connections, connecting, proxy, queryIds, selected, removeSource, removeConfirmation, job, previewKind, previewItems, chosenIds, loadingItems, busy, error, bothConnected, sameAccount, taskActive, chosenCount, previewComplete, wantsRemoval, removalConfirmed, selectionMatchesJob, percentage, retryCountdown, scanCount, parseCurl, connect, disconnect, scan, availableItems, allChosen, toggleAll, toggleItem, begin, cancel, resume }
}
