export type ListKind = 'following' | 'bookmarks'

export interface ListPage<T> {
  items: T[]
  cursor: string | null
}

export class IncompleteListError extends Error {
  constructor(
    message: string,
    readonly englishMessage: string,
  ) {
    super(message)
    this.name = 'IncompleteListError'
  }
}

// X sometimes returns empty pages while a usable bottom cursor still exists.
// Keep the same completion rules in the browser and in direct XClient callers.
export async function readCompleteList<T extends { id: string }>(
  kind: ListKind,
  expectedCount: number | null,
  getPage: (cursor: string | null) => Promise<ListPage<T>>,
  onPage?: (count: number, page: number, inferredEnd: boolean) => void,
  signal?: AbortSignal,
): Promise<T[]> {
  const all: T[] = []
  const seenIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let stalePages = 0
  for (let page = 1; page <= 500; page++) {
    signal?.throwIfAborted()
    const result = await getPage(cursor)
    signal?.throwIfAborted()
    const previousCount = all.length
    for (const item of result.items) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id)
        all.push(item)
      }
    }
    stalePages = all.length === previousCount ? stalePages + 1 : 0
    const repeatedCursor = !!result.cursor && seenCursors.has(result.cursor)
    const knownFollowingCount = kind === 'following' && expectedCount !== null
    const inferredEnd =
      (!!result.cursor &&
        !knownFollowingCount &&
        (stalePages >= 2 || (repeatedCursor && stalePages >= 1))) ||
      (!result.cursor && knownFollowingCount && all.length < expectedCount)
    onPage?.(all.length, page, inferredEnd)
    if (!result.cursor) return all
    if (knownFollowingCount && all.length === expectedCount && stalePages >= 1) return all
    if (inferredEnd) return all
    if (stalePages >= 10) {
      const category = kind === 'following' ? '关注' : '收藏'
      const english = kind === 'following' ? 'follows' : 'bookmarks'
      throw new IncompleteListError(
        `X 连续 10 页未返回新的${category}项目，已停止扫描以避免漏读。第 ${page} 页返回 ${result.items.length} 项，累计 ${all.length} 项${knownFollowingCount ? `，账号资料显示总关注 ${expectedCount} 项` : ''}。`,
        `X returned no new ${english} for 10 pages. Scanning stopped to avoid missing data. Page ${page} returned ${result.items.length}; ${all.length} read in total${knownFollowingCount ? `; profile count: ${expectedCount}` : ''}.`,
      )
    }
    if (repeatedCursor)
      throw new IncompleteListError(
        'X 返回重复分页游标，已停止扫描以避免遗漏数据。',
        'X returned a repeated page cursor. Scanning stopped to avoid missing data.',
      )
    seenCursors.add(result.cursor)
    cursor = result.cursor
  }
  throw new IncompleteListError(
    '列表超过 500 页，已停止扫描以避免只迁移部分数据。',
    'The list exceeds 500 pages. Scanning stopped to avoid a partial transfer.',
  )
}
