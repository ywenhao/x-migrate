export type MigrationKind = 'following' | 'bookmarks'
export type JobStage = 'scanning' | 'ready' | 'running' | 'completed' | 'cancelled' | 'failed'

export interface AccountView {
  id: string
  screenName: string
  name: string
  avatarUrl: string | null
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
  summary: Record<MigrationKind, KindSummary>
  progress: JobProgress
  errors: string[]
  removeSource: Record<MigrationKind, boolean>
}

export interface ItemsPage {
  items: ItemView[]
  total: number
  offset: number
  limit: number
}
