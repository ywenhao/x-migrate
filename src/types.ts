export type MigrationKind = 'following' | 'bookmarks'
export type JobStage =
  'scanning' | 'ready' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface AccountView {
  id: string
  screenName: string
  name: string
  avatarUrl: string | null
  followingCount: number | null
}

export interface ScanListProgress {
  read: number
  total: number | null
  page: number
  done: boolean
  inferredEnd?: boolean
}

export interface ScanKindProgress {
  source: ScanListProgress
  target: ScanListProgress
}

export interface ItemView {
  id: string
  label: string
  detail: string
  url: string
  avatarUrl: string | null
  alreadyThere: boolean
}

export interface KindSummary {
  source: number
  alreadyThere: number
  toCopy: number
}

export interface JobProgress {
  processed: number
  total: number
  copied: number
  alreadyThere: number
  removed: number
  failed: number
}

export interface JobView {
  id: string
  stage: JobStage
  message: string
  source: AccountView
  target: AccountView
  selected: Record<MigrationKind, boolean>
  scanProgress: Record<MigrationKind, ScanKindProgress>
  summary: Record<MigrationKind, KindSummary>
  progress: JobProgress
  retryAt: number | null
  errors: string[]
  removeSource: Record<MigrationKind, boolean>
}

export interface ItemsPage {
  items: ItemView[]
  total: number
  offset: number
  limit: number
}
