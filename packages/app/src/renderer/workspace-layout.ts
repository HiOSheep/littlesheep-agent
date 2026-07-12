export const WORKSPACE_PANEL_WIDTH_DEFAULT = 360
export const WORKSPACE_PANEL_WIDTH_MIN = 280
export const WORKSPACE_PANEL_WIDTH_MAX = 4096
export const WORKSPACE_CHAT_MIN_WIDTH = 420
export const WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH = 96

const SIDEBAR_RESIZER_WIDTH = 1
const WORKSPACE_PANEL_RESIZER_WIDTH = 1

export interface WorkspacePanelLayoutInput {
  viewportWidth: number
  sidebarWidth: number
  sidebarCollapsed: boolean
  preferredWidth: number
}

export interface WorkspacePanelLayout {
  width: number
  maxSplitWidth: number
  availableCoreWidth: number
  minChatWidth: number
  chatCollapseThreshold: number
  panelCollapseThreshold: number
}

export type WorkspacePanelDragMode = 'split' | 'collapsed' | 'fullscreen'

export interface WorkspacePanelDragResult {
  mode: WorkspacePanelDragMode
  width: number
}

/** Resolves the readable split and both second-stage collapse thresholds. */
export function resolveWorkspacePanelLayout(input: WorkspacePanelLayoutInput): WorkspacePanelLayout {
  const viewportWidth = finitePositive(input.viewportWidth)
  const activeSidebarWidth = input.sidebarCollapsed
    ? 0
    : clamp(finitePositive(input.sidebarWidth), 0, viewportWidth)
  const availableCoreWidth = Math.max(0, viewportWidth - activeSidebarWidth - SIDEBAR_RESIZER_WIDTH)
  const availableChatWidth = Math.max(
    0,
    Math.floor(availableCoreWidth - WORKSPACE_PANEL_WIDTH_MIN - WORKSPACE_PANEL_RESIZER_WIDTH),
  )
  const minChatWidth = Math.min(WORKSPACE_CHAT_MIN_WIDTH, availableChatWidth)
  const maxSplitWidth = clamp(
    Math.floor(availableCoreWidth - minChatWidth - WORKSPACE_PANEL_RESIZER_WIDTH),
    WORKSPACE_PANEL_WIDTH_MIN,
    WORKSPACE_PANEL_WIDTH_MAX,
  )
  const width = clamp(input.preferredWidth, WORKSPACE_PANEL_WIDTH_MIN, maxSplitWidth)

  return {
    width,
    maxSplitWidth,
    availableCoreWidth,
    minChatWidth,
    chatCollapseThreshold: minChatWidth / 2,
    panelCollapseThreshold: WORKSPACE_PANEL_WIDTH_MIN / 2,
  }
}

/** Applies the shared two-stage resize rule without letting either pane compress below its readable width. */
export function resolveWorkspacePanelDrag(
  rawPanelWidth: number,
  layout: WorkspacePanelLayout,
): WorkspacePanelDragResult {
  const rawWidth = Number.isFinite(rawPanelWidth) ? rawPanelWidth : layout.width
  if (rawWidth < layout.panelCollapseThreshold) {
    return { mode: 'collapsed', width: WORKSPACE_PANEL_WIDTH_MIN }
  }

  const virtualChatWidth = layout.minChatWidth - Math.max(0, rawWidth - layout.maxSplitWidth)
  if (virtualChatWidth < layout.chatCollapseThreshold) {
    return { mode: 'fullscreen', width: layout.maxSplitWidth }
  }

  return {
    mode: 'split',
    width: clamp(rawWidth, WORKSPACE_PANEL_WIDTH_MIN, layout.maxSplitWidth),
  }
}

/** Detects the full-height, non-blocking reveal zone along the core workspace's right edge. */
export function isWorkspacePanelReopenHotzone(
  pointerX: number,
  coreLeft: number,
  coreRight: number,
  hotzoneWidth = WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH,
): boolean {
  if (![pointerX, coreLeft, coreRight, hotzoneWidth].every(Number.isFinite)) return false
  if (coreRight <= coreLeft || hotzoneWidth <= 0) return false
  const revealStart = Math.max(coreLeft, coreRight - hotzoneWidth)
  return pointerX >= revealStart && pointerX <= coreRight
}

function finitePositive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clamp(value: number, min: number, max: number): number {
  const finiteValue = Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, finiteValue))
}
