import {
  WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
} from '../shared/workspace-contracts'

export {
  WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
} from '../shared/workspace-contracts'

export const WORKSPACE_PANEL_WIDTH_DEFAULT = 360
export const WORKSPACE_PANEL_WIDTH_MIN = 280
export const WORKSPACE_PANEL_WIDTH_MAX = 4096
export const WORKSPACE_CHAT_MIN_WIDTH = 420
// Must stay in sync with --floating-panel-inline-gutter in 03-shell-sidebar.css.
// Width preferences describe the visible panel, not its surrounding float gap.
export const FLOATING_PANEL_INLINE_GUTTER = 16
export const RESPONSIVE_LAYOUT_REFERENCE_WIDTH = 1280
export const RESPONSIVE_LAYOUT_PREFERENCE_MIN = 1
export const RESPONSIVE_LAYOUT_PREFERENCE_MAX = WORKSPACE_PANEL_WIDTH_MAX
export const WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH = 96
export const WORKSPACE_FILE_CONTENT_MIN_WIDTH = 96
export const WORKSPACE_FILE_NAVIGATOR_MAX_RATIO = 0.68

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

export interface WorkspaceFileNavigatorLayout {
  width: number
  minWidth: number
  maxWidth: number
  collapseThreshold: number
}

export interface WorkspaceFileNavigatorDragResult {
  collapsed: boolean
  width: number
}

/**
 * Converts a reference-width preference into the current viewport width while
 * keeping the readable minimum and a stable maximum bound intact.
 */
export function resolveResponsiveWidth(
  preferredReferenceWidth: number,
  viewportWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  const scale = responsiveViewportScale(viewportWidth)
  const preferredWidth = finitePositive(preferredReferenceWidth) * scale
  return Math.round(clamp(preferredWidth, minWidth, maxWidth))
}

/** Converts a current viewport width back into the persisted reference-width preference. */
export function toResponsiveWidthPreference(
  width: number,
  viewportWidth: number,
  maxWidth: number,
): number {
  const scale = responsiveViewportScale(viewportWidth)
  const referenceWidth = finitePositive(width) / scale
  return Math.round(clamp(
    referenceWidth,
    RESPONSIVE_LAYOUT_PREFERENCE_MIN,
    Math.max(RESPONSIVE_LAYOUT_PREFERENCE_MAX, maxWidth),
  ))
}

/** Resolves the readable split and both second-stage collapse thresholds. */
export function resolveWorkspacePanelLayout(input: WorkspacePanelLayoutInput): WorkspacePanelLayout {
  const viewportWidth = finitePositive(input.viewportWidth)
  const activeSidebarWidth = input.sidebarCollapsed
    ? 0
    : clamp(finitePositive(input.sidebarWidth), 0, viewportWidth)
  const activeSidebarFootprint = activeSidebarWidth > 0
    ? activeSidebarWidth + FLOATING_PANEL_INLINE_GUTTER
    : 0
  const availableCoreWidth = Math.max(0, viewportWidth - activeSidebarFootprint - SIDEBAR_RESIZER_WIDTH)
  const availableChatWidth = Math.max(
    0,
    Math.floor(
      availableCoreWidth
      - WORKSPACE_PANEL_WIDTH_MIN
      - FLOATING_PANEL_INLINE_GUTTER
      - WORKSPACE_PANEL_RESIZER_WIDTH,
    ),
  )
  const minChatWidth = Math.min(WORKSPACE_CHAT_MIN_WIDTH, availableChatWidth)
  const maxSplitWidth = clamp(
    Math.floor(
      availableCoreWidth
      - minChatWidth
      - FLOATING_PANEL_INLINE_GUTTER
      - WORKSPACE_PANEL_RESIZER_WIDTH,
    ),
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

/** Keeps the right-side file navigator usable without consuming the entire file surface. */
export function resolveWorkspaceFileNavigatorLayout(
  availableWidth: number,
  preferredWidth: number,
): WorkspaceFileNavigatorLayout {
  const finiteAvailableWidth = finitePositive(availableWidth)
  const maxWidth = finiteAvailableWidth > 0
    ? Math.max(
        0,
        Math.min(
          WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
          Math.floor(finiteAvailableWidth - WORKSPACE_FILE_CONTENT_MIN_WIDTH),
          Math.floor(finiteAvailableWidth * WORKSPACE_FILE_NAVIGATOR_MAX_RATIO),
        ),
      )
    : WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX
  const minWidth = Math.min(WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN, maxWidth)
  const width = clamp(
    Number.isFinite(preferredWidth) ? preferredWidth : WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
    minWidth,
    maxWidth,
  )

  return {
    width,
    minWidth,
    maxWidth,
    collapseThreshold: minWidth / 2,
  }
}

/** Mirrors the sidebar dead zone: stay readable until the second threshold, then collapse. */
export function resolveWorkspaceFileNavigatorDrag(
  rawWidth: number,
  layout: WorkspaceFileNavigatorLayout,
): WorkspaceFileNavigatorDragResult {
  const width = Number.isFinite(rawWidth) ? rawWidth : layout.width
  if (width < layout.collapseThreshold) {
    return { collapsed: true, width: layout.minWidth }
  }
  return {
    collapsed: false,
    width: clamp(width, layout.minWidth, layout.maxWidth),
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

function responsiveViewportScale(viewportWidth: number): number {
  const finiteViewportWidth = finitePositive(viewportWidth)
  return finiteViewportWidth > 0 ? finiteViewportWidth / RESPONSIVE_LAYOUT_REFERENCE_WIDTH : 1
}

function clamp(value: number, min: number, max: number): number {
  const finiteValue = Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, finiteValue))
}
