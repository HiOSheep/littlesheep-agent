// Reusable renderer interaction primitives and icons.

export const COLUMN_RESIZE_END_EVENT = 'littlesheep:column-resize-end'
export const WINDOW_RESIZE_START_EVENT = 'littlesheep:window-resize-start'
export const WINDOW_RESIZE_END_EVENT = 'littlesheep:window-resize-end'
export const WORKSPACE_NAVIGATOR_MOTION_START_EVENT = 'littlesheep:workspace-navigator-motion-start'
export const WORKSPACE_NAVIGATOR_MOTION_END_EVENT = 'littlesheep:workspace-navigator-motion-end'
export const WINDOW_RESIZE_SETTLE_DELAY_MS = 160

export function beginResize(axis: 'column'): void {
  document.body.classList.add('is-resizing', `is-resizing-${axis}`)
}


export function endResize(axis: 'column'): void {
  document.body.classList.remove(`is-resizing-${axis}`)
  if (!document.body.classList.contains('is-resizing-column')) {
    document.body.classList.remove('is-resizing')
    window.dispatchEvent(new Event(COLUMN_RESIZE_END_EVENT))
  }
}
