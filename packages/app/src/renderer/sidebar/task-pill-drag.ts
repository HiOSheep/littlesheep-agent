// Where the floating task pill has been dragged to.
//
// The pill is a HUD over the chat column, so "somewhere else" means a translation from the spot it is
// docked at, and that translation has to stay inside the conversation: a bar dragged off the column
// would sit on the sidebar or the workspace panel, where it belongs to neither (asked for
// 2026-10-03). The value is remembered, and clamped again on every measurement, so a window that
// shrank while the pill was parked cannot leave it outside the column.

export const TASK_PILL_OFFSET_STORAGE = 'littlesheep.ui.taskPillOffset'

export interface TaskPillOffset {
  x: number
  y: number
}

export interface TaskPillRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Offsets under this many pixels still count as docked, so a stray click cannot undock the pill. */
export const TASK_PILL_DOCK_EPSILON = 2

export function isTaskPillDocked(offset: TaskPillOffset | null): boolean {
  if (!offset) return true
  return Math.abs(offset.x) < TASK_PILL_DOCK_EPSILON && Math.abs(offset.y) < TASK_PILL_DOCK_EPSILON
}

function normalize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Keeps `offset` inside `bounds` (the chat column) for a pill whose docked rectangle is `docked`.
 * When the column is narrower than the pill the only honest answer is the docked spot: sliding it
 * would hide part of the bar with nothing to gain.
 */
export function clampTaskPillOffset(
  offset: TaskPillOffset,
  bounds: TaskPillRect,
  docked: TaskPillRect,
): TaskPillOffset {
  const pillWidth = docked.right - docked.left
  const pillHeight = docked.bottom - docked.top
  const availableWidth = bounds.right - bounds.left
  const availableHeight = bounds.bottom - bounds.top
  const minX = pillWidth >= availableWidth ? 0 : bounds.left - docked.left
  const maxX = pillWidth >= availableWidth ? 0 : bounds.right - docked.right
  const minY = pillHeight >= availableHeight ? 0 : bounds.top - docked.top
  const maxY = pillHeight >= availableHeight ? 0 : bounds.bottom - docked.bottom
  return {
    x: Math.min(Math.max(offset.x, minX), maxX),
    y: Math.min(Math.max(offset.y, minY), maxY),
  }
}

type StorageLike = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readTaskPillOffset(storage?: StorageLike): TaskPillOffset | null {
  const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
  if (!target) return null
  try {
    const raw = target.getItem(TASK_PILL_OFFSET_STORAGE)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const x = normalize((parsed as { x?: unknown }).x)
    const y = normalize((parsed as { y?: unknown }).y)
    return x === null || y === null ? null : { x, y }
  } catch {
    return null
  }
}

/** Docking back writes `null` away rather than storing a zero offset. */
export function writeTaskPillOffset(offset: TaskPillOffset | null, storage?: StorageLike): void {
  const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
  if (!target) return
  try {
    if (!offset || isTaskPillDocked(offset)) target.removeItem(TASK_PILL_OFFSET_STORAGE)
    else target.setItem(TASK_PILL_OFFSET_STORAGE, JSON.stringify({ x: offset.x, y: offset.y }))
  } catch {
    // A storage that refuses (private mode, quota) only costs the remembered spot, never the drag.
  }
}
