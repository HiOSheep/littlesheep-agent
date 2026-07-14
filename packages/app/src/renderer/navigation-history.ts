/**
 * Small, in-memory navigation primitives shared by the renderer and tests.
 * The history deliberately stores page state only; messages, file contents,
 * and directory payloads must never be copied into it.
 */

export const MAX_NAVIGATION_HISTORY_ENTRIES = 50
export const MAX_NAVIGATION_EXPANDED_PATHS = 128
export const MAX_NAVIGATION_OPEN_TABS = 64

export interface NavigationHistoryState<T> {
  entries: T[]
  index: number
}

export function appendNavigationEntry<T>(
  state: NavigationHistoryState<T>,
  entry: T,
  equals: (left: T | undefined, right: T) => boolean,
  maxEntries = MAX_NAVIGATION_HISTORY_ENTRIES,
): NavigationHistoryState<T> {
  const safeMax = Math.max(1, Math.floor(maxEntries))
  const active = state.entries[state.index]
  if (equals(active, entry)) return state

  const nextEntries = state.entries.slice(0, Math.max(0, state.index + 1))
  nextEntries.push(entry)
  const overflow = Math.max(0, nextEntries.length - safeMax)
  if (overflow > 0) nextEntries.splice(0, overflow)

  return {
    entries: nextEntries,
    index: nextEntries.length - 1,
  }
}

export function boundStringList(
  values: readonly string[],
  maxEntries: number,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const limit = Math.max(0, Math.floor(maxEntries))
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}
