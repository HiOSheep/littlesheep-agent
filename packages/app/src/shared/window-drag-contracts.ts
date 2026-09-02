// Narrow bridge for moving the one desktop window from a custom titlebar.

export const WINDOW_DRAG_START_CHANNEL = 'littlesheep:window-drag-start'

export const WINDOW_DRAG_MOVE_CHANNEL = 'littlesheep:window-drag-move'

export const WINDOW_DRAG_END_CHANNEL = 'littlesheep:window-drag-end'

export interface WindowDragPoint {
  screenX: number
  screenY: number
}

export function isWindowDragPoint(value: unknown): value is WindowDragPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Partial<WindowDragPoint>
  return isValidCoordinate(point.screenX) && isValidCoordinate(point.screenY)
}

function isValidCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000
}
