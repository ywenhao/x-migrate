import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { readCompleteList, type ListPage } from '../shared/pagination.ts'
import { cookiesFromCurl } from './curl.ts'
import { saveLocale, type Locale } from './i18n.ts'
import { executeTransfer, type TransferEntry, type TransferPlan } from './transfer.ts'
import type { AccountView, ItemView, JobView, MigrationKind, ScanListProgress } from './types.ts'

type Role = 'source' | 'target'
type Credentials = { authToken: string; ct0: string }
type Connection = { account: AccountView }
type PageItem = Omit<ItemView, 'alreadyThere'>

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt: number | null,
  ) {
    super(message)
  }
}

export function useMigration() {
  const { locale, t } = useI18n()
  const STORAGE_KEY = 'x-migrate.browser.v3'
  const credentials = reactive<Record<Role, Credentials>>({
    source: { authToken: '', ct0: '' },
    target: { authToken: '', ct0: '' },
  })
  const connections = reactive<Record<Role, Connection | null>>({ source: null, target: null })
  const curlInput = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlMessage = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlInvalid = reactive<Record<Role, boolean>>({ source: false, target: false })
  const connecting = ref<Role | null>(null)
  const queryIds = reactive({
    Viewer: '',
    UserByScreenName: '',
    Following: '',
    Bookmarks: '',
    CreateBookmark: '',
    DeleteBookmark: '',
  })
  const selected = reactive({ following: true, bookmarks: true })
  const removeSource = reactive({ following: false, bookmarks: false })
  const removeConfirmation = ref('')
  const job = ref<JobView | null>(null)
  const previewKind = ref<MigrationKind>('following')
  const previewItems = reactive<Record<MigrationKind, ItemView[]>>({ following: [], bookmarks: [] })
  const chosenIds = reactive<Record<MigrationKind, Set<string>>>({
    following: new Set(),
    bookmarks: new Set(),
  })
  const loadingItems = reactive({ following: false, bookmarks: false })
  const refreshingKind = ref<MigrationKind | null>(null)
  const busy = ref(false)
  const error = ref('')
  const clockNow = ref(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let scanAbort: AbortController | null = null
  let refreshAbort: AbortController | null = null
  let cancelled = false
  let plan: TransferPlan | null = null

  const bothConnected = computed(() => !!connections.source && !!connections.target)
  const sameAccount = computed(
    () =>
      !!connections.source &&
      !!connections.target &&
      connections.source.account.id === connections.target.account.id,
  )
  const taskActive = computed(
    () =>
      ['scanning', 'running', 'paused'].includes(job.value?.stage || '') ||
      refreshingKind.value !== null,
  )
  const chosenCount = computed(() => chosenIds.following.size + chosenIds.bookmarks.size)
  const canChooseItems = computed(
    () =>
      refreshingKind.value === null &&
      (job.value?.stage === 'ready' || job.value?.stage === 'completed'),
  )
  const remainingCount = computed(
    () => availableItems('following').length + availableItems('bookmarks').length,
  )
  const previewComplete = computed(
    () =>
      !!job.value &&
      (['following', 'bookmarks'] as const).every(
        (kind) =>
          !job.value?.selected[kind] ||
          (job.value.scanProgress[kind].source.done &&
            job.value.scanProgress[kind].target.done &&
            previewItems[kind].length === job.value.summary[kind].source),
      ),
  )
  const wantsRemoval = computed(() => removeSource.following || removeSource.bookmarks)
  const removalConfirmed = computed(
    () =>
      !wantsRemoval.value ||
      removeConfirmation.value === '@' + (job.value?.source.screenName ?? ''),
  )
  const selectionMatchesJob = computed(
    () =>
      !!job.value &&
      selected.following === job.value.selected.following &&
      selected.bookmarks === job.value.selected.bookmarks,
  )
  const percentage = computed(() =>
    job.value?.progress.total
      ? Math.round((job.value.progress.processed / job.value.progress.total) * 100)
      : 0,
  )
  const retryCountdown = computed(() => {
    const seconds = Math.max(0, Math.ceil(((job.value?.retryAt ?? 0) - clockNow.value) / 1000))
    return t('minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
  })

  function persist(): void {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          credentials,
          connections,
          queryIds,
          selected,
          removeSource,
          job: job.value,
          previewItems,
          plan,
          chosenIds: {
            following: [...chosenIds.following],
            bookmarks: [...chosenIds.bookmarks],
          },
        }),
      )
    } catch {
      throw new Error(t('storageUnavailable'))
    }
  }

  function restore(): void {
    try {
      const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as Record<
        string,
        any
      > | null
      if (!raw || typeof raw !== 'object') return
      for (const role of ['source', 'target'] as const) {
        if (raw.credentials?.[role]) Object.assign(credentials[role], raw.credentials[role])
        if (
          raw.connections?.[role]?.account &&
          credentials[role].authToken &&
          credentials[role].ct0
        )
          connections[role] = raw.connections[role]
      }
      if (raw.queryIds) Object.assign(queryIds, raw.queryIds)
      if (raw.selected) Object.assign(selected, raw.selected)
      if (raw.removeSource) Object.assign(removeSource, raw.removeSource)
      if (raw.job?.stage) job.value = raw.job as JobView
      if (raw.previewItems) {
        previewItems.following = raw.previewItems.following || []
        previewItems.bookmarks = raw.previewItems.bookmarks || []
      }
      if (raw.chosenIds) {
        chosenIds.following = new Set(raw.chosenIds.following || [])
        chosenIds.bookmarks = new Set(raw.chosenIds.bookmarks || [])
      }
      if (raw.plan?.entries && Number.isSafeInteger(raw.plan.index)) plan = raw.plan as TransferPlan
      if (!job.value) return
      for (const kind of ['following', 'bookmarks'] as const) {
        const availableIds = new Set(availableItems(kind).map((item) => item.id))
        for (const id of chosenIds[kind]) if (!availableIds.has(id)) chosenIds[kind].delete(id)
        if (job.value.stage === 'completed') updateSummary(kind)
      }
      previewKind.value = job.value.selected.following ? 'following' : 'bookmarks'
      if (job.value.stage === 'scanning') {
        job.value.stage = 'failed'
        job.value.message = t('scanInterrupted')
      } else if (job.value.stage === 'running') {
        job.value.stage = plan && connections.source && connections.target ? 'paused' : 'failed'
        job.value.retryAt = null
        job.value.message = t('transferInterrupted')
      } else if (job.value.stage === 'paused' && (!plan || !bothConnected.value)) {
        job.value.stage = 'failed'
        job.value.message = t('transferInterrupted')
      } else if (job.value.stage === 'ready' && !previewComplete.value) {
        job.value.stage = 'failed'
        job.value.message = t('previewIncomplete')
      }
      persist()
    } catch (cause) {
      showError(cause)
    }
  }

  function describe(cause: unknown): string {
    if (
      cause &&
      typeof cause === 'object' &&
      'englishMessage' in cause &&
      typeof cause.englishMessage === 'string' &&
      locale.value === 'en'
    )
      return cause.englishMessage
    return cause instanceof Error ? cause.message : t('unknownError')
  }
  function showError(cause: unknown): void {
    error.value = describe(cause)
  }
  function save(): void {
    try {
      persist()
    } catch (cause) {
      showError(cause)
    }
  }
  function clearPreview(): void {
    job.value = null
    plan = null
    previewItems.following = []
    previewItems.bookmarks = []
    chosenIds.following.clear()
    chosenIds.bookmarks.clear()
  }
  function parseCurl(role: Role): boolean {
    const cookies = cookiesFromCurl(curlInput[role])
    credentials[role].authToken = ''
    credentials[role].ct0 = ''
    if (!cookies) {
      curlInvalid[role] = true
      curlMessage[role] = 'curlInvalid'
      return false
    }
    Object.assign(credentials[role], cookies)
    curlInput[role] = ''
    curlInvalid[role] = false
    curlMessage[role] = 'curlParsed'
    return true
  }

  async function api<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch('/api' + path, {
      method: 'POST',
      headers: {
        'accept-language': locale.value,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
    const data = (await response.json().catch(() => ({}))) as T & {
      error?: string
      retryAt?: number | null
    }
    if (!response.ok)
      throw new ApiRequestError(
        data.error || t('requestFailed', { status: response.status }),
        response.status,
        typeof data.retryAt === 'number' && Number.isFinite(data.retryAt) ? data.retryAt : null,
      )
    return data
  }
  function withCredentials<T>(
    role: Role,
    path: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return api<T>(
      path,
      {
        ...body,
        authToken: credentials[role].authToken,
        ct0: credentials[role].ct0,
        queryIds,
      },
      signal,
    )
  }

  async function connect(role: Role): Promise<void> {
    error.value = ''
    if (curlInput[role].trim() && !parseCurl(role)) return
    if (!credentials[role].authToken || !credentials[role].ct0) {
      showError(new Error(t('missingCredentials')))
      return
    }
    connecting.value = role
    try {
      const data = await withCredentials<{ account: AccountView }>(role, '/connect')
      connections[role] = { account: data.account }
      clearPreview()
      persist()
    } catch (cause) {
      showError(cause)
    } finally {
      connecting.value = null
    }
  }

  async function disconnect(role: Role): Promise<void> {
    if (taskActive.value) return
    connections[role] = null
    credentials[role].authToken = ''
    credentials[role].ct0 = ''
    clearPreview()
    save()
  }

  function scanCount(progress: ScanListProgress): string {
    return progress.read + ' / ' + (progress.total ?? t('afterScan'))
  }
  function makeProgress(total: number | null = null): ScanListProgress {
    return { read: 0, total, page: 0, done: false }
  }
  function newJob(): JobView {
    return {
      id: crypto.randomUUID(),
      stage: 'scanning',
      message: t('scanning'),
      source: connections.source!.account,
      target: connections.target!.account,
      selected: { ...selected },
      scanProgress: {
        following: {
          source: makeProgress(connections.source!.account.followingCount),
          target: makeProgress(connections.target!.account.followingCount),
        },
        bookmarks: { source: makeProgress(), target: makeProgress() },
      },
      summary: {
        following: { source: 0, alreadyThere: 0, toCopy: 0 },
        bookmarks: { source: 0, alreadyThere: 0, toCopy: 0 },
      },
      progress: { processed: 0, total: 0, copied: 0, alreadyThere: 0, removed: 0, failed: 0 },
      retryAt: null,
      errors: [],
      removeSource: { following: false, bookmarks: false },
    }
  }

  function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(done, ms)
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async function scanList(
    role: Role,
    kind: MigrationKind,
    signal: AbortSignal,
    progress = job.value!.scanProgress[kind][role],
  ): Promise<ItemView[]> {
    let previousRequestFinishedAt = 0
    const saveProgress = progress === job.value!.scanProgress[kind][role]
    const accountId = kind === 'following' ? connections[role]!.account.id : undefined
    const expectedCount = kind === 'following' ? connections[role]!.account.followingCount : null
    const items = await readCompleteList<ItemView>(
      kind,
      expectedCount,
      async (cursor): Promise<ListPage<ItemView>> => {
        const remaining = 2000 - (Date.now() - previousRequestFinishedAt)
        if (previousRequestFinishedAt && remaining > 0) await wait(remaining, signal)
        const data = await withCredentials<ListPage<PageItem>>(
          role,
          '/page',
          { kind, userId: accountId, cursor },
          signal,
        )
        previousRequestFinishedAt = Date.now()
        return {
          cursor: data.cursor,
          items: data.items.map((item) => ({ ...item, alreadyThere: false })),
        }
      },
      (count, page, inferredEnd) => {
        progress.read = count
        progress.page = page
        progress.inferredEnd = inferredEnd
        if (saveProgress) persist()
      },
      signal,
    )
    progress.done = true
    progress.total = items.length
    if (saveProgress) persist()
    return items
  }

  async function scan(): Promise<void> {
    if (
      !bothConnected.value ||
      sameAccount.value ||
      taskActive.value ||
      (!selected.following && !selected.bookmarks)
    )
      return
    error.value = ''
    busy.value = true
    cancelled = false
    const controller = new AbortController()
    scanAbort = controller
    clearPreview()
    removeSource.following = false
    removeSource.bookmarks = false
    removeConfirmation.value = ''
    job.value = newJob()
    try {
      persist()
      const scanned: Record<MigrationKind, Record<Role, ItemView[] | null>> = {
        following: { source: null, target: null },
        bookmarks: { source: null, target: null },
      }
      async function scanAccount(role: Role): Promise<void> {
        for (const kind of ['following', 'bookmarks'] as const) {
          if (!job.value?.selected[kind]) continue
          const items = await scanList(role, kind, controller.signal)
          if (cancelled) throw new Error(t('scanStopped'))
          scanned[kind][role] = items
          const source = scanned[kind].source
          const target = scanned[kind].target
          if (!source || !target) continue
          const targetIds = new Set(target.map((item) => item.id))
          source.forEach((item) => {
            item.alreadyThere = targetIds.has(item.id)
          })
          previewItems[kind] = source
          updateSummary(kind)
          persist()
        }
      }
      const scans = [scanAccount('source'), scanAccount('target')]
      try {
        await Promise.all(scans)
      } catch (cause) {
        controller.abort()
        await Promise.allSettled(scans)
        throw cause
      }
      if (cancelled) throw new Error(t('scanStopped'))
      const uncertain = (['following', 'bookmarks'] as const).some(
        (kind) =>
          job.value!.selected[kind] &&
          (job.value!.scanProgress[kind].source.inferredEnd ||
            job.value!.scanProgress[kind].target.inferredEnd),
      )
      job.value.stage = 'ready'
      job.value.message = t(uncertain ? 'scanCompleteUncertain' : 'scanComplete')
      previewKind.value = selected.following ? 'following' : 'bookmarks'
      persist()
    } catch (cause) {
      if (job.value) {
        job.value.stage = cancelled ? 'cancelled' : 'failed'
        job.value.message = cancelled ? t('scanStopped') : describe(cause)
        save()
      }
      if (!cancelled) showError(cause)
    } finally {
      busy.value = false
      scanAbort = null
    }
  }

  async function refreshKind(kind: MigrationKind): Promise<void> {
    if (
      !job.value ||
      !canChooseItems.value ||
      !bothConnected.value ||
      sameAccount.value ||
      busy.value
    )
      return
    error.value = ''
    busy.value = true
    refreshingKind.value = kind
    loadingItems[kind] = true
    const controller = new AbortController()
    refreshAbort = controller
    const previous = {
      items: previewItems[kind],
      progress: job.value.scanProgress[kind],
      summary: job.value.summary[kind],
      chosen: new Set(chosenIds[kind]),
      selected: selected[kind],
      jobSelected: job.value.selected[kind],
      previewKind: previewKind.value,
      message: job.value.message,
    }
    let changed = false
    try {
      const progress = {
        source: makeProgress(
          kind === 'following' ? connections.source!.account.followingCount : null,
        ),
        target: makeProgress(
          kind === 'following' ? connections.target!.account.followingCount : null,
        ),
      }
      const scans = [
        scanList('source', kind, controller.signal, progress.source),
        scanList('target', kind, controller.signal, progress.target),
      ] as const
      let pages: [ItemView[], ItemView[]]
      try {
        pages = await Promise.all(scans)
      } catch (cause) {
        controller.abort()
        await Promise.allSettled(scans)
        throw cause
      }
      controller.signal.throwIfAborted()
      const [source, target] = pages
      const targetIds = new Set(target.map((item) => item.id))
      source.forEach((item) => {
        item.alreadyThere = targetIds.has(item.id)
      })
      changed = true
      previewItems[kind] = source
      job.value.scanProgress[kind] = progress
      job.value.selected[kind] = true
      selected[kind] = true
      const availableIds = new Set(
        source.filter((item) => !item.alreadyThere).map((item) => item.id),
      )
      chosenIds[kind] = new Set([...previous.chosen].filter((id) => availableIds.has(id)))
      updateSummary(kind)
      previewKind.value = kind
      const label = t(kind === 'following' ? 'follows' : 'bookmarks')
      job.value.message = t(
        progress.source.inferredEnd || progress.target.inferredEnd
          ? 'refreshCompleteUncertain'
          : 'refreshComplete',
        { kind: label },
      )
      persist()
    } catch (cause) {
      if (changed && job.value) {
        previewItems[kind] = previous.items
        job.value.scanProgress[kind] = previous.progress
        job.value.summary[kind] = previous.summary
        job.value.selected[kind] = previous.jobSelected
        selected[kind] = previous.selected
        chosenIds[kind] = previous.chosen
        previewKind.value = previous.previewKind
        job.value.message = previous.message
      }
      if (controller.signal.reason !== 'refresh-stopped') showError(cause)
    } finally {
      loadingItems[kind] = false
      refreshingKind.value = null
      refreshAbort = null
      busy.value = false
    }
  }

  function availableItems(kind: MigrationKind): ItemView[] {
    return previewItems[kind].filter((item) => !item.alreadyThere)
  }
  function updateSummary(kind: MigrationKind): void {
    if (!job.value) return
    const source = previewItems[kind].length
    const toCopy = availableItems(kind).length
    job.value.summary[kind] = { source, alreadyThere: source - toCopy, toCopy }
  }
  function allChosen(kind: MigrationKind): boolean {
    const items = availableItems(kind)
    return items.length > 0 && items.every((item) => chosenIds[kind].has(item.id))
  }
  function toggleAll(kind: MigrationKind): void {
    if (!canChooseItems.value) return
    const clear = allChosen(kind)
    for (const item of availableItems(kind))
      clear ? chosenIds[kind].delete(item.id) : chosenIds[kind].add(item.id)
    save()
  }
  function toggleItem(kind: MigrationKind, id: string): void {
    if (!canChooseItems.value || !availableItems(kind).some((item) => item.id === id)) return
    chosenIds[kind].has(id) ? chosenIds[kind].delete(id) : chosenIds[kind].add(id)
    save()
  }
  function action(role: Role, kind: MigrationKind, id: string, remove: boolean): Promise<unknown> {
    const name =
      kind === 'following'
        ? remove
          ? 'unfollow'
          : 'follow'
        : remove
          ? 'removeBookmark'
          : 'addBookmark'
    return withCredentials(role, '/action', { action: name, id })
  }

  function clearRetryTimer(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
  function scheduleRetry(): void {
    clearRetryTimer()
    if (!job.value?.retryAt || job.value.stage !== 'paused') return
    const remaining = Math.max(0, job.value.retryAt - Date.now())
    retryTimer = setTimeout(
      () => {
        if (busy.value) {
          retryTimer = setTimeout(scheduleRetry, 1000)
        } else if (
          job.value?.stage === 'paused' &&
          job.value.retryAt &&
          Date.now() >= job.value.retryAt
        )
          void resume()
        else scheduleRetry()
      },
      Math.min(remaining, 2_147_000_000),
    )
  }

  async function runTransfer(): Promise<void> {
    if (!job.value || !plan) return
    busy.value = true
    try {
      const result = await executeTransfer(plan, job.value.progress, {
        action: async (role, kind, id, remove) => {
          await action(role, kind, id, remove)
        },
        copied: (entry) => {
          const item = previewItems[entry.kind].find((value) => value.id === entry.id)
          if (item) item.alreadyThere = true
          chosenIds[entry.kind].delete(entry.id)
          updateSummary(entry.kind)
        },
        checkpoint: persist,
        failed: (entry, cause) => {
          const item = previewItems[entry.kind].find((value) => value.id === entry.id)
          if (job.value!.errors.length < 100)
            job.value!.errors.push((item?.detail || entry.id) + ': ' + describe(cause))
        },
        paused: (cause) => {
          const retryAt = cause instanceof ApiRequestError ? cause.retryAt : null
          job.value!.stage = 'paused'
          job.value!.message = describe(cause)
          job.value!.retryAt =
            retryAt && retryAt > Date.now() ? retryAt : Date.now() + 15 * 60 * 1000
          persist()
          scheduleRetry()
        },
        cancelled: () => cancelled,
        delay: (ms) => wait(ms),
        isRateLimit: (cause) => cause instanceof ApiRequestError && cause.status === 429,
      })
      if (result === 'paused') return
      if (result === 'cancelled') {
        job.value.stage = 'cancelled'
        job.value.message = t('transferStopped')
      } else {
        job.value.stage = 'completed'
        job.value.message = t(
          job.value.progress.failed
            ? 'transferCompleteWithFailures'
            : remainingCount.value
              ? 'transferBatchComplete'
              : 'transferComplete',
        )
        plan = null
      }
      job.value.retryAt = null
      persist()
    } catch (cause) {
      job.value.stage = 'failed'
      job.value.message = describe(cause)
      showError(cause)
      save()
    } finally {
      busy.value = false
    }
  }

  async function begin(): Promise<void> {
    if (
      !job.value ||
      !canChooseItems.value ||
      !chosenCount.value ||
      !previewComplete.value ||
      !removalConfirmed.value ||
      !selectionMatchesJob.value ||
      !bothConnected.value
    )
      return
    error.value = ''
    cancelled = false
    const previousStage = job.value.stage
    const previousProgress = { ...job.value.progress }
    const previousErrors = [...job.value.errors]
    const previousMessage = job.value.message
    const previousRemoveSource = { ...job.value.removeSource }
    const entries: TransferEntry[] = []
    for (const kind of ['following', 'bookmarks'] as const) {
      if (!job.value.selected[kind]) continue
      for (const item of availableItems(kind))
        if (chosenIds[kind].has(item.id)) entries.push({ kind, id: item.id, phase: 'copy' })
    }
    if (!entries.length) return
    plan = {
      entries,
      index: 0,
      removeSource: {
        following: job.value.selected.following && removeSource.following,
        bookmarks: job.value.selected.bookmarks && removeSource.bookmarks,
      },
    }
    job.value.removeSource = { ...plan.removeSource }
    job.value.progress = {
      processed: 0,
      total: entries.length,
      copied: 0,
      alreadyThere: 0,
      removed: 0,
      failed: 0,
    }
    job.value.stage = 'running'
    job.value.message = t('running')
    job.value.errors = []
    try {
      persist()
    } catch (cause) {
      job.value.stage = previousStage
      job.value.progress = previousProgress
      job.value.errors = previousErrors
      job.value.message = previousMessage
      job.value.removeSource = previousRemoveSource
      plan = null
      showError(cause)
      return
    }
    await runTransfer()
  }

  async function cancel(): Promise<void> {
    if (!job.value || !taskActive.value) return
    if (refreshingKind.value) {
      refreshAbort?.abort('refresh-stopped')
      return
    }
    cancelled = true
    clearRetryTimer()
    if (job.value.stage === 'scanning') {
      scanAbort?.abort()
      job.value.stage = 'cancelled'
      job.value.message = t('scanStopped')
      save()
    } else if (job.value.stage === 'paused') {
      job.value.stage = 'cancelled'
      job.value.retryAt = null
      job.value.message = t('transferStopped')
      save()
    } else {
      job.value.message = t('stopping')
      save()
    }
  }

  async function resume(): Promise<void> {
    if (job.value?.stage !== 'paused' || !plan || busy.value) return
    clearRetryTimer()
    cancelled = false
    job.value.stage = 'running'
    job.value.retryAt = null
    job.value.message = t('running')
    try {
      persist()
    } catch (cause) {
      job.value.stage = 'paused'
      showError(cause)
      return
    }
    await runTransfer()
  }

  function setLocale(next: Locale): void {
    locale.value = next
    saveLocale(next)
  }
  onMounted(() => {
    restore()
    clockTimer = setInterval(() => {
      clockNow.value = Date.now()
    }, 1000)
    scheduleRetry()
  })
  onUnmounted(() => {
    if (clockTimer) clearInterval(clockTimer)
    clearRetryTimer()
    refreshAbort?.abort('refresh-stopped')
  })

  return {
    t,
    locale,
    setLocale,
    credentials,
    curlInput,
    curlMessage,
    curlInvalid,
    connections,
    connecting,
    queryIds,
    selected,
    removeSource,
    removeConfirmation,
    job,
    previewKind,
    previewItems,
    chosenIds,
    loadingItems,
    busy,
    error,
    bothConnected,
    sameAccount,
    taskActive,
    chosenCount,
    canChooseItems,
    remainingCount,
    previewComplete,
    wantsRemoval,
    removalConfirmed,
    selectionMatchesJob,
    percentage,
    retryCountdown,
    scanCount,
    parseCurl,
    connect,
    disconnect,
    scan,
    refreshKind,
    availableItems,
    allChosen,
    toggleAll,
    toggleItem,
    begin,
    cancel,
    resume,
  }
}
