<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { AccountView, ItemView, ItemsPage, JobView, MigrationKind, ScanListProgress } from './types'

type Role = 'source' | 'target'
interface Connection { sessionId: string; account: AccountView }
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
const queryIds = reactive({ Viewer: '', UserByScreenName: '', Following: '', Bookmarks: '', CreateBookmark: '', DeleteBookmark: '' })
const selected = reactive({ following: true, bookmarks: true })
const removeSource = reactive({ following: false, bookmarks: false })
const removeConfirmation = ref('')
const job = ref<JobView | null>(null)
const previewKind = ref<MigrationKind>('following')
const previewItems = reactive<Record<MigrationKind, ItemView[]>>({ following: [], bookmarks: [] })
const loadingItems = reactive({ following: false, bookmarks: false })
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null
let polling = false

const bothConnected = computed(() => !!connections.source && !!connections.target)
const sameAccount = computed(() => !!connections.source && !!connections.target &&
  connections.source.account.id === connections.target.account.id)
const taskActive = computed(() => job.value?.stage === 'scanning' || job.value?.stage === 'running')
const wantsRemoval = computed(() => removeSource.following || removeSource.bookmarks)
const removalConfirmed = computed(() => !wantsRemoval.value ||
  removeConfirmation.value === `@${job.value?.source.screenName ?? ''}`)
const selectionMatchesJob = computed(() => !!job.value &&
  selected.following === job.value.selected.following &&
  selected.bookmarks === job.value.selected.bookmarks)
const percentage = computed(() => {
  const progress = job.value?.progress
  return progress?.total ? Math.round(progress.processed / progress.total * 100) : 0
})

function scanCount(progress: ScanListProgress): string {
  return `${progress.read} / ${progress.total ?? '扫描后确认'}`
}

function persistSession(): void {
  const saved = {
    source: connections.source?.sessionId ?? null,
    target: connections.target?.sessionId ?? null,
    jobId: job.value?.id ?? null,
  }
  try {
    if (saved.source || saved.target || saved.jobId) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved))
    else sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch { /* The app still works when browser storage is unavailable. */ }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`)
  return data
}

async function restoreSession(): Promise<void> {
  let saved: Record<string, unknown>
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null') as Record<string, unknown>
  } catch { return }
  if (!saved || typeof saved !== 'object') return

  for (const role of ['source', 'target'] as const) {
    const sessionId = saved[role]
    if (typeof sessionId !== 'string' || !/^[a-f\d-]{36}$/.test(sessionId)) continue
    try {
      const connection = await api<Connection>(`/sessions/${sessionId}`)
      if (!connections[role]) connections[role] = connection
    } catch { /* The server process may have restarted or the session expired. */ }
  }

  const jobId = saved.jobId
  if (connections.source && connections.target &&
    connections.source.sessionId === saved.source && connections.target.sessionId === saved.target &&
    typeof jobId === 'string' && /^[a-f\d-]{36}$/.test(jobId)) {
    try {
      const data = await api<{ job: JobView }>(`/jobs/${jobId}`)
      if (!job.value && data.job.source.id === connections.source.account.id &&
        data.job.target.id === connections.target.account.id) {
        job.value = data.job
        selected.following = data.job.selected.following
        selected.bookmarks = data.job.selected.bookmarks
        removeSource.following = data.job.removeSource.following
        removeSource.bookmarks = data.job.removeSource.bookmarks
        previewKind.value = data.job.selected.following ? 'following' : 'bookmarks'
        if (data.job.stage === 'scanning' || data.job.stage === 'running') startPolling()
        if (data.job.stage !== 'scanning') {
          await Promise.all((['following', 'bookmarks'] as const)
            .filter((kind) => data.job.selected[kind])
            .map((kind) => loadItems(kind, true)))
        }
      }
    } catch { /* An expired job can be scanned again. */ }
  }
  persistSession()
}

function showError(cause: unknown): void {
  error.value = cause instanceof Error ? cause.message : '发生未知错误。'
}

function parseCurl(role: Role): boolean {
  const command = curlInput[role].replace(/\\\r?\n/g, ' ')
  const options = /(?:^|\s)(-b|--cookie|-H|--header)(?:\s+|=)(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+))/gi
  credentials[role].authToken = ''
  credentials[role].ct0 = ''

  for (const match of command.matchAll(options)) {
    const option = match[1].toLowerCase()
    const argument = match[2] ?? match[3]?.replace(/\\(["\\])/g, '$1') ?? match[4] ?? ''
    const cookie = option === '-b' || option === '--cookie'
      ? argument
      : /^cookie\s*:/i.test(argument) ? argument.replace(/^cookie\s*:\s*/i, '') : ''
    if (!cookie) continue

    const values = new Map<string, string>()
    for (const part of cookie.split(';')) {
      const equals = part.indexOf('=')
      if (equals < 0) continue
      const name = part.slice(0, equals).trim()
      const value = part.slice(equals + 1).trim().replace(/^"(.*)"$/s, '$1')
      if (name === 'auth_token' || name === 'ct0') values.set(name, value)
    }

    const authToken = values.get('auth_token')
    const ct0 = values.get('ct0')
    if (authToken && ct0) {
      credentials[role].authToken = authToken
      credentials[role].ct0 = ct0
      curlInput[role] = ''
      curlInvalid[role] = false
      curlMessage[role] = '已提取 auth_token 和 ct0。'
      return true
    }
  }

  curlInvalid[role] = true
  curlMessage[role] = '未在 curl 的 Cookie 中同时找到 auth_token 和 ct0。'
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
    persistSession()
  } catch (cause) { showError(cause) }
  finally { connecting.value = null }
}

async function disconnect(role: Role): Promise<void> {
  const connection = connections[role]
  if (!connection) return
  error.value = ''
  try {
    await api('/disconnect', { sessionId: connection.sessionId })
    connections[role] = null
    job.value = null
    stopPolling()
    persistSession()
  } catch (cause) { showError(cause) }
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function poll(): Promise<void> {
  if (!job.value || polling) return
  polling = true
  try {
    const previous = job.value.stage
    const data = await api<{ job: JobView }>(`/jobs/${job.value.id}`)
    if (!job.value || job.value.id !== data.job.id || job.value.stage === 'cancelled') return
    job.value = data.job
    if (data.job.stage === 'ready' && previous !== 'ready') {
      stopPolling()
      await Promise.all((['following', 'bookmarks'] as const)
        .filter((kind) => data.job.selected[kind])
        .map((kind) => loadItems(kind, true)))
    } else if (['completed', 'cancelled', 'failed'].includes(data.job.stage)) {
      stopPolling()
    }
  } catch (cause) {
    stopPolling()
    showError(cause)
  } finally { polling = false }
}

function startPolling(): void {
  stopPolling()
  timer = setInterval(() => { void poll() }, 2500)
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
  } catch (cause) { showError(cause) }
  finally { busy.value = false }
}

async function loadItems(kind: MigrationKind, reset = false): Promise<void> {
  if (!job.value || loadingItems[kind]) return
  loadingItems[kind] = true
  try {
    const offset = reset ? 0 : previewItems[kind].length
    const data = await api<ItemsPage>(`/jobs/${job.value.id}/items?kind=${kind}&offset=${offset}`)
    previewItems[kind] = reset ? data.items : [...previewItems[kind], ...data.items]
  } catch (cause) { showError(cause) }
  finally { loadingItems[kind] = false }
}

async function begin(): Promise<void> {
  if (!job.value || !removalConfirmed.value || !selectionMatchesJob.value) return
  error.value = ''
  busy.value = true
  try {
    const data = await api<{ job: JobView }>(`/jobs/${job.value.id}/start`, {
      removeFollowing: removeSource.following,
      removeBookmarks: removeSource.bookmarks,
      removeConfirmation: wantsRemoval.value ? removeConfirmation.value : '',
    })
    job.value = data.job
    startPolling()
  } catch (cause) { showError(cause) }
  finally { busy.value = false }
}

async function cancel(): Promise<void> {
  if (!job.value) return
  error.value = ''
  try {
    const data = await api<{ job: JobView }>(`/jobs/${job.value.id}/cancel`, {})
    job.value = data.job
    if (data.job.stage === 'cancelled') stopPolling()
  } catch (cause) { showError(cause) }
}

onMounted(() => { void restoreSession() })
onUnmounted(stopPolling)
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">↗</span><span>X 迁移助手</span></div>
      <div class="side-intro">
        <span class="eyebrow">ACCOUNT TRANSFER</span>
        <h2>把喜欢的内容，<br>带到新账号。</h2>
        <p>迁移关注和收藏。先预览，再执行，每一步都由你决定。</p>
      </div>
      <div class="side-steps" aria-label="迁移步骤">
        <div class="side-step"><span>01</span><div><strong>连接账号</strong><small>分别验证旧账号与新账号</small></div></div>
        <div class="side-step"><span>02</span><div><strong>扫描预览</strong><small>自动识别新账号已有内容</small></div></div>
        <div class="side-step"><span>03</span><div><strong>执行迁移</strong><small>可选清理旧账号</small></div></div>
      </div>
      <div class="side-footer"><span class="local-dot"></span>仅在本机运行 · 会话保存在当前进程</div>
    </aside>

    <main class="main-content">
      <header class="page-header">
        <div><span class="eyebrow">X / TWITTER</span><h1>账号迁移工作台</h1><p>按顺序完成连接、扫描与迁移。关闭服务后，账号会话即失效。</p></div>
        <span class="header-badge">本地工具</span>
      </header>

      <div v-if="error" class="alert error-alert" role="alert">
        <strong>操作未完成</strong><span>{{ error }}</span><button type="button" aria-label="关闭错误提示" @click="error = ''">×</button>
      </div>

      <section class="section" aria-labelledby="connection-heading">
        <div class="section-heading"><span class="section-number">01</span><div><h2 id="connection-heading">连接两个账号</h2><p>粘贴 X 请求的 curl 后可直接连接，或手动填写 <code>auth_token</code> 和 <code>ct0</code>。</p></div></div>
        <div class="account-grid">
          <article class="account-card">
            <div class="card-top"><span class="account-role">来源账号</span><span class="account-tag source-tag">旧账号</span></div>
            <template v-if="connections.source">
              <div class="connected-profile">
                <img v-if="connections.source.account.avatarUrl" :src="connections.source.account.avatarUrl" alt="" referrerpolicy="no-referrer">
                <span v-else class="avatar-fallback">{{ connections.source.account.name.slice(0, 1) }}</span>
                <div><strong>{{ connections.source.account.name }}</strong><small>@{{ connections.source.account.screenName }}</small></div>
              </div>
              <div class="connected-line"><span class="check-dot">✓</span> 会话已验证</div>
              <div class="connected-line">总关注 {{ connections.source.account.followingCount ?? '扫描后确认' }}</div>
              <button class="text-button" type="button" :disabled="taskActive" @click="disconnect('source')">断开连接</button>
            </template>
            <form v-else @submit.prevent="connect('source')">
              <label for="source-curl">从 curl 提取 Cookie</label>
              <textarea id="source-curl" v-model="curlInput.source" rows="3" autocomplete="off" spellcheck="false" placeholder="粘贴旧账号的 X 请求 curl 命令"></textarea>
              <button class="parse-button" type="button" :disabled="!curlInput.source.trim()" @click="parseCurl('source')">解析 curl</button>
              <p v-if="curlMessage.source" :class="['curl-message', { invalid: curlInvalid.source }]" role="status">{{ curlMessage.source }}</p>
              <div class="field-divider">或手动填写</div>
              <label for="source-auth">auth_token</label>
              <input id="source-auth" v-model="credentials.source.authToken" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴旧账号 auth_token" :required="!curlInput.source.trim()">
              <label for="source-ct0">ct0</label>
              <input id="source-ct0" v-model="credentials.source.ct0" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴旧账号 ct0" :required="!curlInput.source.trim()">
              <button class="button button-dark full" type="submit" :disabled="connecting !== null">{{ connecting === 'source' ? '正在验证…' : '连接旧账号' }}</button>
            </form>
          </article>

          <div class="transfer-arrow" aria-hidden="true">→</div>

          <article class="account-card">
            <div class="card-top"><span class="account-role">目标账号</span><span class="account-tag target-tag">新账号</span></div>
            <template v-if="connections.target">
              <div class="connected-profile">
                <img v-if="connections.target.account.avatarUrl" :src="connections.target.account.avatarUrl" alt="" referrerpolicy="no-referrer">
                <span v-else class="avatar-fallback">{{ connections.target.account.name.slice(0, 1) }}</span>
                <div><strong>{{ connections.target.account.name }}</strong><small>@{{ connections.target.account.screenName }}</small></div>
              </div>
              <div class="connected-line"><span class="check-dot">✓</span> 会话已验证</div>
              <div class="connected-line">总关注 {{ connections.target.account.followingCount ?? '扫描后确认' }}</div>
              <button class="text-button" type="button" :disabled="taskActive" @click="disconnect('target')">断开连接</button>
            </template>
            <form v-else @submit.prevent="connect('target')">
              <label for="target-curl">从 curl 提取 Cookie</label>
              <textarea id="target-curl" v-model="curlInput.target" rows="3" autocomplete="off" spellcheck="false" placeholder="粘贴新账号的 X 请求 curl 命令"></textarea>
              <button class="parse-button" type="button" :disabled="!curlInput.target.trim()" @click="parseCurl('target')">解析 curl</button>
              <p v-if="curlMessage.target" :class="['curl-message', { invalid: curlInvalid.target }]" role="status">{{ curlMessage.target }}</p>
              <div class="field-divider">或手动填写</div>
              <label for="target-auth">auth_token</label>
              <input id="target-auth" v-model="credentials.target.authToken" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴新账号 auth_token" :required="!curlInput.target.trim()">
              <label for="target-ct0">ct0</label>
              <input id="target-ct0" v-model="credentials.target.ct0" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴新账号 ct0" :required="!curlInput.target.trim()">
              <button class="button button-dark full" type="submit" :disabled="connecting !== null">{{ connecting === 'target' ? '正在验证…' : '连接新账号' }}</button>
            </form>
          </article>
        </div>
        <p v-if="sameAccount" class="inline-warning">两个会话属于同一个 X 账号，请更换其中一个。</p>
        <details class="help-details"><summary>在哪里找到 Cookie？</summary><p>分别登录两个 X 账号，在浏览器开发者工具的 Network 中选择带 Cookie 的 X 请求，复制为 curl 后粘贴到对应账号；也可以在“应用 / Application → Cookies → https://x.com”中手动复制 <code>auth_token</code> 和 <code>ct0</code> 的值。会话相当于密码，请只在你信任的本机使用。</p></details>
        <details class="help-details advanced"><summary>高级设置：代理与查询 ID</summary>
          <div class="advanced-content">
            <label for="proxy">网络代理</label><input id="proxy" v-model="proxy" autocomplete="off" spellcheck="false" placeholder="留空自动检测；或填 127.0.0.1:7890 / direct">
            <p>留空时依次使用环境变量、Windows 系统代理。填写 <code>direct</code> 可强制直连。修改后需重新连接账号。</p>
            <div class="query-grid">
              <label v-for="(_, operation) in queryIds" :key="operation">{{ operation }}<input v-model="queryIds[operation]" autocomplete="off" spellcheck="false" placeholder="自动发现"></label>
            </div>
            <p>如果 X 轮换了查询 ID 且自动发现失败，可在 X 网页开发者工具的 Network 中找到对应请求，将 <code>/graphql/</code> 后的一段 ID 填入，再重新连接。</p>
          </div>
        </details>
      </section>

      <section class="section" aria-labelledby="scan-heading">
        <div class="section-heading"><span class="section-number">02</span><div><h2 id="scan-heading">选择并扫描</h2><p>完整读取两个账号的所选列表，计算待迁移和已有数量。</p></div></div>
        <div class="choice-row">
          <label class="choice"><input v-model="selected.following" type="checkbox" :disabled="taskActive"><span class="choice-icon">◎</span><span><strong>关注的人</strong><small>把旧账号关注的用户，关注到新账号</small></span></label>
          <label class="choice"><input v-model="selected.bookmarks" type="checkbox" :disabled="taskActive"><span class="choice-icon">◇</span><span><strong>收藏的推文</strong><small>把旧账号收藏的推文，收藏到新账号</small></span></label>
        </div>
        <div class="action-row"><button class="button button-primary" type="button" :disabled="!bothConnected || sameAccount || (!selected.following && !selected.bookmarks) || taskActive || busy" @click="scan">{{ busy ? '正在准备…' : job ? '重新扫描' : '开始扫描' }} <span aria-hidden="true">↗</span></button><span v-if="!bothConnected" class="muted-note">连接两个账号后即可扫描</span></div>
      </section>

      <section v-if="job" class="section result-section" aria-labelledby="result-heading">
        <div class="section-heading"><span class="section-number">03</span><div><h2 id="result-heading">预览与执行</h2><p>{{ job.message }}</p></div></div>
        <div v-if="job.stage === 'scanning'" class="status-panel"><span class="spinner" aria-hidden="true"></span><div><strong>正在扫描列表</strong><p>{{ job.message }}</p></div><button class="text-button" type="button" @click="cancel">停止</button></div>
        <div v-if="job.stage === 'scanning' || ((job.stage === 'failed' || job.stage === 'cancelled') && job.progress.total === 0)" class="summary-grid scan-progress-grid">
          <div v-if="job.selected.following" class="summary-card"><span>关注人数</span><strong>{{ scanCount(job.scanProgress.following.source) }}</strong><small>旧账号已读取 / 总关注</small><small>新账号 {{ scanCount(job.scanProgress.following.target) }}</small></div>
          <div v-if="job.selected.bookmarks" class="summary-card"><span>收藏数量</span><strong>{{ scanCount(job.scanProgress.bookmarks.source) }}</strong><small>旧账号已读取 / 总收藏</small><small>新账号 {{ scanCount(job.scanProgress.bookmarks.target) }}</small></div>
        </div>
        <template v-if="job.stage !== 'scanning'">
          <div v-if="(job.stage !== 'failed' && job.stage !== 'cancelled') || job.progress.total > 0" class="summary-grid">
            <div v-if="job.selected.following" class="summary-card"><span>关注的人</span><strong>{{ job.summary.following.source }}</strong><small>待新增 {{ job.summary.following.toCopy }} · 已有 {{ job.summary.following.alreadyThere }}</small><small>新账号总关注 {{ job.scanProgress.following.target.total ?? job.scanProgress.following.target.read }}</small></div>
            <div v-if="job.selected.bookmarks" class="summary-card"><span>收藏的推文</span><strong>{{ job.summary.bookmarks.source }}</strong><small>待新增 {{ job.summary.bookmarks.toCopy }} · 已有 {{ job.summary.bookmarks.alreadyThere }}</small><small>新账号总收藏 {{ job.scanProgress.bookmarks.target.total ?? job.scanProgress.bookmarks.target.read }}</small></div>
          </div>
          <div v-if="job.stage !== 'failed' || job.progress.total > 0" class="preview-block">
            <div class="preview-header"><h3>内容预览</h3><div class="tabs"><button v-if="job.selected.following" type="button" :class="{ active: previewKind === 'following' }" @click="previewKind = 'following'">关注</button><button v-if="job.selected.bookmarks" type="button" :class="{ active: previewKind === 'bookmarks' }" @click="previewKind = 'bookmarks'">收藏</button></div></div>
            <p class="preview-explainer">“新账号已有”会跳过新增；若选择清理旧账号，它仍会在确认后从旧账号移除。</p>
            <div v-if="previewItems[previewKind].length" class="item-list">
              <a v-for="item in previewItems[previewKind]" :key="item.id" class="preview-item" :href="item.url" target="_blank" rel="noopener noreferrer">
                <img v-if="item.avatarUrl" :src="item.avatarUrl" alt="" referrerpolicy="no-referrer"><span v-else class="item-avatar">{{ item.detail.slice(0, 1) }}</span>
                <span class="item-copy"><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span>
                <span :class="['item-status', item.alreadyThere ? 'already' : 'new']">{{ item.alreadyThere ? '新账号已有' : '待迁移' }}</span>
              </a>
            </div>
            <p v-else class="empty-list">{{ job.summary[previewKind].source ? '正在加载预览…' : '没有可迁移的项目。' }}</p>
            <button v-if="previewItems[previewKind].length < job.summary[previewKind].source" class="load-more" type="button" :disabled="loadingItems[previewKind]" @click="loadItems(previewKind)">{{ loadingItems[previewKind] ? '正在加载…' : '加载更多' }}</button>
          </div>

          <div v-if="job.stage === 'ready'" class="execution-panel">
            <div><h3>迁移后处理旧账号</h3><p>默认保留旧账号内容。只会在目标账号确认已有该项后移除。</p></div>
            <p v-if="!selectionMatchesJob" class="inline-warning">迁移内容已改变，请点击“重新扫描”更新预览。</p>
            <div class="remove-options"><label v-if="job.selected.following"><input v-model="removeSource.following" type="checkbox"> 移除旧账号的关注</label><label v-if="job.selected.bookmarks"><input v-model="removeSource.bookmarks" type="checkbox"> 移除旧账号的收藏</label></div>
            <div v-if="wantsRemoval" class="confirmation"><label for="remove-confirmation">请输入 <strong>@{{ job.source.screenName }}</strong> 确认清理旧账号</label><input id="remove-confirmation" v-model="removeConfirmation" autocomplete="off" spellcheck="false" :placeholder="`@${job.source.screenName}`"></div>
            <div class="action-row"><button class="button button-primary" type="button" :disabled="busy || !removalConfirmed || !selectionMatchesJob" @click="begin">{{ busy ? '正在启动…' : wantsRemoval ? '确认并开始迁移' : '开始迁移' }} <span aria-hidden="true">→</span></button><span class="muted-note">迁移过程中可以停止，已完成的操作不会撤销。</span></div>
          </div>

          <div v-if="job.stage === 'running' || (job.progress.total > 0 && job.stage !== 'ready')" class="progress-panel">
            <div class="progress-top"><strong>{{ job.stage === 'running' ? '正在迁移' : job.stage === 'completed' ? '迁移已结束' : job.stage === 'cancelled' ? '迁移已停止' : '迁移中断' }}</strong><span>{{ job.progress.processed }} / {{ job.progress.total }}</span></div>
            <div class="progress-track"><div :style="{ width: `${percentage}%` }"></div></div>
            <div class="progress-stats"><span>新增 {{ job.progress.copied }}</span><span>目标已有 {{ job.progress.alreadyThere }}</span><span>从旧账号移除 {{ job.progress.removed }}</span><span>失败 {{ job.progress.failed }}</span></div>
            <button v-if="job.stage === 'running'" class="text-button" type="button" @click="cancel">停止任务</button>
          </div>
          <div v-if="job.stage === 'failed' && job.progress.total === 0" class="alert error-alert"><strong>扫描未完成</strong><span>{{ job.message }}</span></div>
          <details v-if="job.errors.length" class="error-details"><summary>查看问题记录（{{ job.errors.length }}）</summary><ul><li v-for="(entry, index) in job.errors" :key="index">{{ entry }}</li></ul></details>
        </template>
      </section>

      <footer class="page-footer">X 迁移助手 · 本地运行工具 · X 接口变化或限流时，请按提示重试</footer>
    </main>
  </div>
</template>
