// Bounds renderer-only detail responses without duplicating authoritative memory state.

import type { MemoryTreeNodeDetail } from '../api'

export function boundedNodeDetailCache(
  current: Record<string, MemoryTreeNodeDetail>,
  detail: MemoryTreeNodeDetail,
): Record<string, MemoryTreeNodeDetail> {
  const next = { ...current }
  delete next[detail.nodeId]
  next[detail.nodeId] = detail
  const ids = Object.keys(next)
  while (ids.length > 24) delete next[ids.shift()!]
  return next
}
