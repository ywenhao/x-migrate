import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { cookiesFromCurl } from './curl'
import { saveLocale, type Locale } from './i18n'
import type {
  AccountView,
  ItemView,
  ItemsPage,
  JobView,
  MigrationKind,
  ScanListProgress,
} from './types'

export function useMigration() {
  const { locale, t } = useI18n()
  function setLocale(next: Locale): void {
    locale.value = next
    saveLocale(next)
    if (job.value) void poll()
  }

  type Role = 'source' | 'target'
  interface Connection {
    sessionId: string
    account: AccountView
  }
  const SESSION_STORAGE_KEY = 'x-migrate.session.v1'

  const credentials = reactive({
    source: { authToken: '', ct0: '' },
    target: { authToken: '', ct0: '' },
  })
  const curlInput = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlMessage = reactive<Record<Role, string>>({ source: '', target: '' })
  const curlInvalid = reactive<Record<Role, boolean>>({ source: false, target: false })
  const connections = reactive<Record<Role, Connection | null>>({ source: null, target: null })
  const connecting = ref<Role | null>(null)
  const proxy = ref('')
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
  const busy = ref(false)
  const error = ref('')
  const clockNow = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false

  const bothConnected = computed(() => !!connections.source && !!connections.target)
  const sameAccount = computed(
    () =>
      !!connections.source &&
      !!connections.target &&
      connections.source.account.id === connections.target.account.id,
  )
  const taskActive = computed(
    () =>
      job.value?.stage === 'scanning' ||
      job.value?.stage === 'running' ||
      job.value?.stage === 'paused',
  )
  const chosenCount = computed(() => chosenIds.following.size + chosenIds.bookmarks.size)
  const previewComplete = computed(
    () =>
      !job.value ||
      (['following', 'bookmarks'] as const).every(
        (kind) =>
          !job.value?.selected[kind] ||
          previewItems[kind].length === job.value.summary[kind].source,
      ),
  )
  const wantsRemoval = computed(() => removeSource.following || removeSource.bookmarks)
  const removalConfirmed = computed(
    () =>
      !wantsRemoval.value || removeConfirmation.value === `@${job.value?.source.screenName ?? ''}`,
  )
  const selectionMatchesJob = computed(
    () =>
      !!job.value &&
      selected.following === job.value.selected.following &&
      selected.bookmarks === job.value.selected.bookmarks,
  )
  const percentage = computed(() => {
    const progress = job.value?.progress
    return progress?.total ? Math.round((progress.processed / progress.total) * 100) : 0
  })
  const retryCountdown = computed(() => {
    const remaining = Math.max(0, Math.ceil(((job.value?.retryAt ?? 0) - clockNow.value) / 1000))
    return t('minutesSeconds', { minutes: Math.floor(remaining / 60), seconds: remaining % 60 })
  })

  function scanCount(progress: ScanListProgress): string {
    return `${progress.read} / ${progress.total ?? t('afterScan')}`
  }

  function persistSession(): void {
    const saved = {
      source: connections.source?.sessionId ?? null,
      target: connections.target?.sessionId ?? null,
      jobId: job.value?.id ?? null,
    }
    try {
      if (saved.source || saved.target || saved.jobId)
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved))
      else sessionStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      /* The app still works when browser storage is unavailable. */
    }
  }

  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'accept-language': locale.value,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
    const data = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(data.error || t('requestFailed', { status: response.status }))
    return data
  }

  async function restoreSession(): Promise<void> {
    let saved: Record<string, unknown>
    try {
      saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null') as Record<
        string,
        unknown
      >
    } catch {
      return
    }
    if (!saved || typeof saved !== 'object') return

    for (const role of ['source', 'target'] as const) {
      const sessionId = saved[role]
      if (typeof sessionId !== 'string' || !/^[a-f\d-]{36}$/.test(sessionId)) continue
      try {
        const connection = await api<Connection>(`/sessions/${sessionId}`)
        if (!connections[role]) connections[role] = connection
      } catch {
        /* The server process may have restarted or the session expired. */
      }
    }

    const jobId = saved.jobId
    if (
      connections.source &&
      connections.target &&
      connections.source.sessionId === saved.source &&
      connections.target.sessionId === saved.target &&
      typeof jobId === 'string' &&
      /^[a-f\d-]{36}$/.test(jobId)
    ) {
      try {
        const data = await api<{ job: JobView }>(`/jobs/${jobId}`)
        if (
          !job.value &&
          data.job.source.id === connections.source.account.id &&
          data.job.target.id === connections.target.account.id
        ) {
          job.value = data.job
          selected.following = data.job.selected.following
          selected.bookmarks = data.job.selected.bookmarks
          removeSource.following = data.job.removeSource.following
          removeSource.bookmarks = data.job.removeSource.bookmarks
          previewKind.value = data.job.selected.following ? 'following' : 'bookmarks'
          if (
            data.job.stage === 'scanning' ||
            data.job.stage === 'running' ||
            data.job.stage === 'paused'
          )
            startPolling()
          if (data.job.stage !== 'scanning') {
            await Promise.all(
              (['following', 'bookmarks'] as const)
                .filter((kind) => data.job.selected[kind])
                .map((kind) => loadItems(kind)),
            )
          }
        }
      } catch {
        /* An expired job can be scanned again. */
      }
    }
    persistSession()
  }

  function showError(cause: unknown): void {
    error.value = cause instanceof Error ? cause.message : t('unknownError')
  }

  function parseCurl(role: Role): boolean {
    const cookies = cookiesFromCurl(curlInput[role])
    credentials[role].authToken = ''
    credentials[role].ct0 = ''
    if (cookies) {
      credentials[role].authToken = cookies.authToken
      credentials[role].ct0 = cookies.ct0
      curlInput[role] = ''
      curlInvalid[role] = false
      curlMessage[role] = 'curlParsed'
      return true
    }

    curlInvalid[role] = true
    curlMessage[role] = 'curlInvalid'
    return false
  }

  async function connect(role: Role): Promise<void> {
    error.value = ''
    if (curlInput[role].trim() && !parseCurl(role)) return
    connecting.value = role
    try {
      const data = await api<{ sessionId: string; account: AccountView }>('/connect', {
        authToken: credentials[role].authToken,
        ct0: credentials[role].ct0,
        proxy: proxy.value,
        queryIds,
      })
      connections[role] = data
      credentials[role].authToken = ''
      credentials[role].ct0 = ''
      curlMessage[role] = ''
      job.value = null
      chosenIds.following.clear()
      chosenIds.bookmarks.clear()
      persistSession()
    } catch (cause) {
      showError(cause)
    } finally {
      connecting.value = null
    }
  }

  async function disconnect(role: Role): Promise<void> {
    const connection = connections[role]
    if (!connection) return
    error.value = ''
    try {
      await api('/disconnect', { sessionId: connection.sessionId })
      connections[role] = null
      job.value = null
      chosenIds.following.clear()
      chosenIds.bookmarks.clear()
      stopPolling()
      persistSession()
    } catch (cause) {
      showError(cause)
    }
  }

  function stopPolling(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  async function poll(): Promise<void> {
    if (!job.value || polling) return
    clockNow.value = Date.now()
    polling = true
    try {
      const previous = job.value.stage
      const data = await api<{ job: JobView }>(`/jobs/${job.value.id}`)
      if (!job.value || job.value.id !== data.job.id || job.value.stage === 'cancelled') return
      job.value = data.job
      if (data.job.stage === 'ready' && previous !== 'ready') {
        stopPolling()
        await Promise.all(
          (['following', 'bookmarks'] as const)
            .filter((kind) => data.job.selected[kind])
            .map((kind) => loadItems(kind)),
        )
      } else if (['completed', 'cancelled', 'failed'].includes(data.job.stage)) {
        stopPolling()
      }
    } catch (cause) {
      stopPolling()
      showError(cause)
    } finally {
      polling = false
    }
  }

  function startPolling(): void {
    stopPolling()
    timer = setInterval(() => {
      void poll()
    }, 2500)
    void poll()
  }

  async function scan(): Promise<void> {
    if (!connections.source || !connections.target) return
    error.value = ''
    busy.value = true
    try {
      removeSource.following = false
      removeSource.bookmarks = false
      removeConfirmation.value = ''
      previewItems.following = []
      previewItems.bookmarks = []
      chosenIds.following.clear()
      chosenIds.bookmarks.clear()
      const data = await api<{ job: JobView }>('/scan', {
        sourceSessionId: connections.source.sessionId,
        targetSessionId: connections.target.sessionId,
        following: selected.following,
        bookmarks: selected.bookmarks,
      })
      job.value = data.job
      previewKind.value = selected.following ? 'following' : 'bookmarks'
      persistSession()
      startPolling()
    } catch (cause) {
      showError(cause)
    } finally {
      busy.value = false
    }
  }

  async function loadItems(kind: MigrationKind): Promise<void> {
    if (!job.value || loadingItems[kind]) return
    const jobId = job.value.id
    loadingItems[kind] = true
    try {
      const items: ItemView[] = []
      let total = 0
      do {
        const data = await api<ItemsPage>(
          `/jobs/${jobId}/items?kind=${kind}&offset=${items.length}`,
        )
        total = data.total
        if (!data.items.length && items.length < total) throw new Error(t('previewIncomplete'))
        items.push(...data.items)
      } while (items.length < total && job.value?.id === jobId)
      if (job.value?.id === jobId) previewItems[kind] = items
    } catch (cause) {
      showError(cause)
    } finally {
      loadingItems[kind] = false
    }
  }

  function availableItems(kind: MigrationKind): ItemView[] {
    return previewItems[kind].filter((item) => !item.alreadyThere)
  }

  function allChosen(kind: MigrationKind): boolean {
    const items = availableItems(kind)
    return items.length > 0 && items.every((item) => chosenIds[kind].has(item.id))
  }

  function toggleAll(kind: MigrationKind): void {
    if (job.value?.stage !== 'ready') return
    const items = availableItems(kind)
    const clear = allChosen(kind)
    for (const item of items) {
      if (clear) chosenIds[kind].delete(item.id)
      else chosenIds[kind].add(item.id)
    }
  }

  function toggleItem(kind: MigrationKind, id: string): void {
    if (job.value?.stage !== 'ready' || !availableItems(kind).some((item) => item.id === id)) return
    if (chosenIds[kind].has(id)) chosenIds[kind].delete(id)
    else chosenIds[kind].add(id)
  }

  async function begin(): Promise<void> {
    if (
      !job.value ||
      !chosenCount.value ||
      !previewComplete.value ||
      !removalConfirmed.value ||
      !selectionMatchesJob.value
    )
      return
    error.value = ''
    busy.value = true
    try {
      const data = await api<{ job: JobView }>(`/jobs/${job.value.id}/start`, {
        removeFollowing: removeSource.following,
        removeBookmarks: removeSource.bookmarks,
        removeConfirmation: wantsRemoval.value ? removeConfirmation.value : '',
        followingIds: [...chosenIds.following],
        bookmarkIds: [...chosenIds.bookmarks],
      })
      job.value = data.job
      startPolling()
    } catch (cause) {
      showError(cause)
    } finally {
      busy.value = false
    }
  }

  async function cancel(): Promise<void> {
    if (!job.value) return
    error.value = ''
    try {
      const data = await api<{ job: JobView }>(`/jobs/${job.value.id}/cancel`, {})
      job.value = data.job
      if (data.job.stage === 'cancelled') stopPolling()
    } catch (cause) {
      showError(cause)
    }
  }

  async function resume(): Promise<void> {
    if (job.value?.stage !== 'paused') return
    error.value = ''
    busy.value = true
    try {
      const data = await api<{ job: JobView }>(`/jobs/${job.value.id}/resume`, {})
      job.value = data.job
      startPolling()
    } catch (cause) {
      showError(cause)
    } finally {
      busy.value = false
    }
  }

  onMounted(() => {
    void restoreSession()
  })
  onUnmounted(stopPolling)

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
    proxy,
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
    availableItems,
    allChosen,
    toggleAll,
    toggleItem,
    begin,
    cancel,
    resume,
  }
}
