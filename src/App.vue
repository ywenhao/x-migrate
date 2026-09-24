<script setup vapor lang="ts">
import { useMigration } from './useMigration'
import AccountCard from './AccountCard.vue'

const {
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
} = useMigration()
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">↗</span><span>{{ t('brand') }}</span>
      </div>
      <div class="side-intro">
        <span class="eyebrow">{{ t('eyebrow') }}</span>
        <h2>{{ t('sideTitleLine1') }}<br />{{ t('sideTitleLine2') }}</h2>
        <p>{{ t('sideIntro') }}</p>
      </div>
      <div class="side-steps" :aria-label="t('eyebrow')">
        <div class="side-step">
          <span>01</span>
          <div>
            <strong>{{ t('connectStep') }}</strong
            ><small>{{ t('connectStepHint') }}</small>
          </div>
        </div>
        <div class="side-step">
          <span>02</span>
          <div>
            <strong>{{ t('scanStep') }}</strong
            ><small>{{ t('scanStepHint') }}</small>
          </div>
        </div>
        <div class="side-step">
          <span>03</span>
          <div>
            <strong>{{ t('migrateStep') }}</strong
            ><small>{{ t('migrateStepHint') }}</small>
          </div>
        </div>
      </div>
      <div class="side-footer"><span class="local-dot"></span>{{ t('localFooter') }}</div>
    </aside>

    <main class="main-content">
      <header class="page-header">
        <div>
          <span class="eyebrow">X / TWITTER</span>
          <h1>{{ t('heading') }}</h1>
          <p>{{ t('headingHint') }}</p>
        </div>
        <div class="header-actions">
          <div class="language-switch" role="group" aria-label="Language">
            <button type="button" :aria-pressed="locale === 'en'" @click="setLocale('en')">
              EN</button
            ><button type="button" :aria-pressed="locale === 'zh-CN'" @click="setLocale('zh-CN')">
              中文
            </button>
          </div>
          <span class="header-badge">{{ t('localTool') }}</span>
        </div>
      </header>

      <div v-if="error" class="alert error-alert" role="alert">
        <strong>{{ t('operationFailed') }}</strong
        ><span>{{ error }}</span
        ><button type="button" :aria-label="t('dismissError')" @click="error = ''">×</button>
      </div>

      <section class="section" aria-labelledby="connection-heading">
        <div class="section-heading">
          <span class="section-number">01</span>
          <div>
            <h2 id="connection-heading">{{ t('connectHeading') }}</h2>
            <p>{{ t('connectHint') }}</p>
          </div>
        </div>
        <div class="account-grid">
          <AccountCard
            role="source"
            :connection="connections.source"
            :connecting="connecting"
            :task-active="taskActive"
            :curl-message="curlMessage.source"
            :curl-invalid="curlInvalid.source"
            v-model:curl="curlInput.source"
            v-model:auth-token="credentials.source.authToken"
            v-model:ct0="credentials.source.ct0"
            @parse="parseCurl('source')"
            @connect="connect('source')"
            @disconnect="disconnect('source')"
          />

          <div class="transfer-arrow" aria-hidden="true">→</div>

          <AccountCard
            role="target"
            :connection="connections.target"
            :connecting="connecting"
            :task-active="taskActive"
            :curl-message="curlMessage.target"
            :curl-invalid="curlInvalid.target"
            v-model:curl="curlInput.target"
            v-model:auth-token="credentials.target.authToken"
            v-model:ct0="credentials.target.ct0"
            @parse="parseCurl('target')"
            @connect="connect('target')"
            @disconnect="disconnect('target')"
          />
        </div>
        <p v-if="sameAccount" class="inline-warning">{{ t('sameAccount') }}</p>
        <details class="help-details">
          <summary>{{ t('cookieHelpTitle') }}</summary>
          <p>{{ t('cookieHelp') }}</p>
        </details>
        <details class="help-details advanced">
          <summary>{{ t('advancedTitle') }}</summary>
          <div class="advanced-content">
            <label for="proxy">{{ t('networkProxy') }}</label
            ><input
              id="proxy"
              v-model="proxy"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('proxyPlaceholder')"
            />
            <p>{{ t('proxyHelp') }}</p>
            <div class="query-grid">
              <label v-for="(_, operation) in queryIds" :key="operation"
                >{{ operation
                }}<input
                  v-model="queryIds[operation]"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="t('autoDiscover')"
              /></label>
            </div>
            <p>{{ t('queryHelp') }}</p>
          </div>
        </details>
      </section>

      <section class="section" aria-labelledby="scan-heading">
        <div class="section-heading">
          <span class="section-number">02</span>
          <div>
            <h2 id="scan-heading">{{ t('scanHeading') }}</h2>
            <p>{{ t('scanHint') }}</p>
          </div>
        </div>
        <div class="choice-row">
          <label class="choice"
            ><input v-model="selected.following" type="checkbox" :disabled="taskActive" /><span
              class="choice-icon"
              >◎</span
            ><span
              ><strong>{{ t('follows') }}</strong
              ><small>{{ t('followsHint') }}</small></span
            ></label
          >
          <label class="choice"
            ><input v-model="selected.bookmarks" type="checkbox" :disabled="taskActive" /><span
              class="choice-icon"
              >◇</span
            ><span
              ><strong>{{ t('bookmarks') }}</strong
              ><small>{{ t('bookmarksHint') }}</small></span
            ></label
          >
        </div>
        <div class="action-row">
          <button
            class="button button-primary"
            type="button"
            :disabled="
              !bothConnected ||
              sameAccount ||
              (!selected.following && !selected.bookmarks) ||
              taskActive ||
              busy
            "
            @click="scan"
          >
            {{ busy ? t('preparing') : job ? t('rescan') : t('startScan') }}
            <span aria-hidden="true">↗</span></button
          ><span v-if="!bothConnected" class="muted-note">{{ t('connectFirst') }}</span>
        </div>
      </section>

      <section v-if="job" class="section result-section" aria-labelledby="result-heading">
        <div class="section-heading">
          <span class="section-number">03</span>
          <div>
            <h2 id="result-heading">{{ t('resultHeading') }}</h2>
            <p>{{ job.message }}</p>
          </div>
        </div>
        <div v-if="job.stage === 'scanning'" class="status-panel">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <strong>{{ t('scanning') }}</strong>
            <p>{{ job.message }}</p>
          </div>
          <button class="text-button" type="button" @click="cancel">{{ t('stop') }}</button>
        </div>
        <div
          v-if="
            job.stage === 'scanning' ||
            ((job.stage === 'failed' || job.stage === 'cancelled') && job.progress.total === 0)
          "
          class="summary-grid scan-progress-grid"
        >
          <div v-if="job.selected.following" class="summary-card">
            <span>{{ t('followsCount') }}</span
            ><strong>{{ scanCount(job.scanProgress.following.source) }}</strong
            ><small>{{ t('sourceRead') }}</small
            ><small>{{
              t('targetRead', { count: scanCount(job.scanProgress.following.target) })
            }}</small>
          </div>
          <div v-if="job.selected.bookmarks" class="summary-card">
            <span>{{ t('bookmarksCount') }}</span
            ><strong>{{ scanCount(job.scanProgress.bookmarks.source) }}</strong
            ><small>{{ t('sourceRead') }}</small
            ><small>{{
              t('targetRead', { count: scanCount(job.scanProgress.bookmarks.target) })
            }}</small>
          </div>
        </div>
        <template v-if="job.stage !== 'scanning'">
          <div
            v-if="(job.stage !== 'failed' && job.stage !== 'cancelled') || job.progress.total > 0"
            class="summary-grid"
          >
            <div v-if="job.selected.following" class="summary-card">
              <span>{{ t('follows') }}</span
              ><strong>{{ job.summary.following.source }}</strong
              ><small>{{
                t('newAndExisting', {
                  newCount: job.summary.following.toCopy,
                  existingCount: job.summary.following.alreadyThere,
                })
              }}</small
              ><small>{{
                t('targetTotalFollows', {
                  count:
                    job.scanProgress.following.target.total ??
                    job.scanProgress.following.target.read,
                })
              }}</small>
            </div>
            <div v-if="job.selected.bookmarks" class="summary-card">
              <span>{{ t('bookmarks') }}</span
              ><strong>{{ job.summary.bookmarks.source }}</strong
              ><small>{{
                t('newAndExisting', {
                  newCount: job.summary.bookmarks.toCopy,
                  existingCount: job.summary.bookmarks.alreadyThere,
                })
              }}</small
              ><small>{{
                t('targetTotalBookmarks', {
                  count:
                    job.scanProgress.bookmarks.target.total ??
                    job.scanProgress.bookmarks.target.read,
                })
              }}</small>
            </div>
          </div>
          <div v-if="job.stage !== 'failed' || job.progress.total > 0" class="preview-block">
            <div class="preview-header">
              <div class="preview-title">
                <h3>{{ t('preview') }}</h3>
                <label class="select-all"
                  ><input
                    type="checkbox"
                    :checked="allChosen(previewKind)"
                    :disabled="
                      job.stage !== 'ready' ||
                      loadingItems[previewKind] ||
                      !availableItems(previewKind).length
                    "
                    @change="toggleAll(previewKind)"
                  />
                  {{ t('selectAll') }}</label
                ><span class="muted-note">{{ t('selectedCount', { count: chosenCount }) }}</span>
              </div>
              <div class="tabs">
                <button
                  v-if="job.selected.following"
                  type="button"
                  :class="{ active: previewKind === 'following' }"
                  @click="previewKind = 'following'"
                >
                  {{ t('follows') }}</button
                ><button
                  v-if="job.selected.bookmarks"
                  type="button"
                  :class="{ active: previewKind === 'bookmarks' }"
                  @click="previewKind = 'bookmarks'"
                >
                  {{ t('bookmarks') }}
                </button>
              </div>
            </div>
            <p class="preview-explainer">{{ t('previewHint') }}</p>
            <div v-if="previewItems[previewKind].length" class="item-list">
              <div v-for="item in previewItems[previewKind]" :key="item.id" class="preview-item">
                <input
                  class="preview-select"
                  type="checkbox"
                  :aria-label="t('selectItem', { label: item.label })"
                  :checked="chosenIds[previewKind].has(item.id)"
                  :disabled="item.alreadyThere || job.stage !== 'ready'"
                  @change="toggleItem(previewKind, item.id)"
                />
                <a class="preview-link" :href="item.url" target="_blank" rel="noopener noreferrer"
                  ><img
                    v-if="item.avatarUrl"
                    :src="item.avatarUrl"
                    alt=""
                    referrerpolicy="no-referrer"
                  /><span v-else class="item-avatar">{{ item.detail.slice(0, 1) }}</span
                  ><span class="item-copy"
                    ><strong>{{ item.label }}</strong
                    ><small>{{ item.detail }}</small></span
                  ></a
                >
                <span :class="['item-status', item.alreadyThere ? 'already' : 'new']">{{
                  item.alreadyThere ? t('alreadyThere') : t('toTransfer')
                }}</span>
              </div>
            </div>
            <p v-else class="empty-list">
              {{ loadingItems[previewKind] ? t('loadingPreview') : t('noItems') }}
            </p>
          </div>

          <div v-if="job.stage === 'ready'" class="execution-panel">
            <div>
              <h3>{{ t('cleanupHeading') }}</h3>
              <p>{{ t('cleanupHint') }}</p>
            </div>
            <p v-if="!selectionMatchesJob" class="inline-warning">{{ t('selectionChanged') }}</p>
            <p v-if="!chosenCount" class="inline-warning">{{ t('selectOne') }}</p>
            <div class="remove-options">
              <label v-if="job.selected.following"
                ><input v-model="removeSource.following" type="checkbox" />
                {{ t('removeFollows') }}</label
              ><label v-if="job.selected.bookmarks"
                ><input v-model="removeSource.bookmarks" type="checkbox" />
                {{ t('removeBookmarks') }}</label
              >
            </div>
            <div v-if="wantsRemoval" class="confirmation">
              <label for="remove-confirmation">{{
                t('confirmRemoval', { handle: `@${job.source.screenName}` })
              }}</label
              ><input
                id="remove-confirmation"
                v-model="removeConfirmation"
                autocomplete="off"
                spellcheck="false"
                :placeholder="`@${job.source.screenName}`"
              />
            </div>
            <div class="action-row">
              <button
                class="button button-primary"
                type="button"
                :disabled="
                  busy ||
                  !chosenCount ||
                  !previewComplete ||
                  loadingItems.following ||
                  loadingItems.bookmarks ||
                  !removalConfirmed ||
                  !selectionMatchesJob
                "
                @click="begin"
              >
                {{ busy ? t('starting') : wantsRemoval ? t('confirmStart') : t('startTransfer') }}
                ({{ chosenCount }}) <span aria-hidden="true">→</span></button
              ><span class="muted-note">{{ t('cannotUndo') }}</span>
            </div>
          </div>

          <div v-if="job.stage === 'paused'" class="status-panel pause-panel">
            <div>
              <strong>{{ t('ratePaused') }}</strong>
              <p>{{ t('autoResume', { message: job.message, time: retryCountdown }) }}</p>
            </div>
            <button class="text-button" type="button" :disabled="busy" @click="resume">
              {{ t('resume') }}</button
            ><button class="text-button" type="button" @click="cancel">{{ t('stopJob') }}</button>
          </div>
          <div
            v-if="job.stage === 'running' || (job.progress.total > 0 && job.stage !== 'ready')"
            class="progress-panel"
          >
            <div class="progress-top">
              <strong>{{
                job.stage === 'running'
                  ? t('running')
                  : job.stage === 'paused'
                    ? t('ratePaused')
                    : job.stage === 'completed'
                      ? t('completed')
                      : job.stage === 'cancelled'
                        ? t('cancelled')
                        : t('interrupted')
              }}</strong
              ><span>{{ job.progress.processed }} / {{ job.progress.total }}</span>
            </div>
            <div class="progress-track"><div :style="{ width: `${percentage}%` }"></div></div>
            <div class="progress-stats">
              <span>{{ t('addedCount', { count: job.progress.copied }) }}</span
              ><span>{{ t('existingCount', { count: job.progress.alreadyThere }) }}</span
              ><span>{{ t('removedCount', { count: job.progress.removed }) }}</span
              ><span>{{ t('failedCount', { count: job.progress.failed }) }}</span>
            </div>
            <button
              v-if="job.stage === 'running'"
              class="text-button"
              type="button"
              @click="cancel"
            >
              {{ t('stopJob') }}
            </button>
          </div>
          <div v-if="job.stage === 'failed' && job.progress.total === 0" class="alert error-alert">
            <strong>{{ t('scanFailed') }}</strong
            ><span>{{ job.message }}</span>
          </div>
          <details v-if="job.errors.length" class="error-details">
            <summary>{{ t('issueLog', { count: job.errors.length }) }}</summary>
            <ul>
              <li v-for="(entry, index) in job.errors" :key="index">{{ entry }}</li>
            </ul>
          </details>
        </template>
      </section>

      <footer class="page-footer">{{ t('footer') }}</footer>
    </main>
  </div>
</template>
