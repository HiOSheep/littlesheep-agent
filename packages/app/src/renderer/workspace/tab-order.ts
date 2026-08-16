// Deterministic workspace-tab ordering shared by pointer interaction and tests.

export function moveWorkspaceTab<T>(
  tabs: readonly T[],
  draggedTab: T,
  targetIndex: number,
): T[] {
  const sourceIndex = tabs.indexOf(draggedTab)
  if (sourceIndex < 0) return [...tabs]

  const next = [...tabs]
  next.splice(sourceIndex, 1)
  const insertAt = Math.max(0, Math.min(Math.trunc(targetIndex), next.length))
  next.splice(insertAt, 0, draggedTab)
  return next
}

export function applyWorkspaceTabSubsetOrder<T>(
  allTabs: readonly T[],
  orderedVisibleTabs: readonly T[],
): T[] {
  const visible = new Set(orderedVisibleTabs)
  let visibleIndex = 0
  return allTabs.map((tab) => {
    if (!visible.has(tab)) return tab
    const nextTab = orderedVisibleTabs[visibleIndex]
    visibleIndex += 1
    return nextTab ?? tab
  })
}
