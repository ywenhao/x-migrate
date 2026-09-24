import type { JobProgress, MigrationKind } from './types'

export interface TransferEntry {
  kind: MigrationKind
  id: string
  phase: 'copy' | 'remove'
}

export interface TransferPlan {
  entries: TransferEntry[]
  index: number
  removeSource: Record<MigrationKind, boolean>
}

export interface TransferHooks {
  action(role: 'source' | 'target', kind: MigrationKind, id: string, remove: boolean): Promise<void>
  checkpoint(): void
  copied(entry: TransferEntry): void
  failed(entry: TransferEntry, error: unknown): void
  paused(error: unknown): void
  cancelled(): boolean
  delay(ms: number): Promise<void>
  isRateLimit(error: unknown): boolean
}

export async function executeTransfer(
  plan: TransferPlan,
  progress: JobProgress,
  hooks: TransferHooks,
): Promise<'completed' | 'paused' | 'cancelled'> {
  while (plan.index < plan.entries.length) {
    if (hooks.cancelled()) return 'cancelled'
    const entry = plan.entries[plan.index]
    try {
      if (entry.phase === 'copy') {
        await hooks.action('target', entry.kind, entry.id, false)
        progress.copied++
        hooks.copied(entry)
        if (plan.removeSource[entry.kind]) entry.phase = 'remove'
        else {
          progress.processed++
          plan.index++
        }
      } else {
        await hooks.action('source', entry.kind, entry.id, true)
        progress.removed++
        progress.processed++
        plan.index++
      }
    } catch (error) {
      if (hooks.isRateLimit(error)) {
        hooks.paused(error)
        return 'paused'
      }
      hooks.failed(entry, error)
      progress.failed++
      progress.processed++
      plan.index++
      hooks.checkpoint()
      continue
    }
    hooks.checkpoint()
    if (plan.index < plan.entries.length || entry.phase === 'remove') await hooks.delay(900)
  }
  return 'completed'
}
