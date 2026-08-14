export const WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND = 32

export interface WorkspaceTabLabelMotion {
  durationMs: number
  offsetPx: number
  overflowPx: number
}

export function resolveWorkspaceTabLabelMotion(
  viewportWidth: number,
  contentWidth: number,
): WorkspaceTabLabelMotion {
  const measuredOverflow = Math.max(0, Math.ceil(contentWidth - viewportWidth))
  const overflowPx = measuredOverflow > 1 ? measuredOverflow : 0
  return {
    durationMs: overflowPx === 0
      ? 0
      : Math.max(1, Math.round((overflowPx / WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND) * 1_000)),
    offsetPx: overflowPx === 0 ? 0 : -overflowPx,
    overflowPx,
  }
}
