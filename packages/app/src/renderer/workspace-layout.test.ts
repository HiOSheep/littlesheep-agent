import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
  WORKSPACE_FILE_NAVIGATOR_MAX_RATIO,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
  FLOATING_PANEL_INLINE_GUTTER,
  WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  RESPONSIVE_LAYOUT_REFERENCE_WIDTH,
  isWorkspacePanelReopenHotzone,
  resolveResponsiveWidth,
  resolveWorkspaceFileNavigatorDrag,
  resolveWorkspaceFileNavigatorLayout,
  resolveWorkspacePanelDrag,
  resolveWorkspacePanelLayout,
  toResponsiveWidthPreference,
} from './workspace-layout'

describe('shared responsive width scaling', () => {
  it('scales a reference width with the viewport while retaining readability bounds', () => {
    expect(resolveResponsiveWidth(360, RESPONSIVE_LAYOUT_REFERENCE_WIDTH, 280, WORKSPACE_PANEL_WIDTH_MAX)).toBe(360)
    expect(resolveResponsiveWidth(360, 1920, 280, WORKSPACE_PANEL_WIDTH_MAX)).toBe(540)
    expect(resolveResponsiveWidth(360, 800, 280, WORKSPACE_PANEL_WIDTH_MAX)).toBe(280)
  })

  it('round-trips a resized width back to the reference preference', () => {
    expect(toResponsiveWidthPreference(540, 1920, WORKSPACE_PANEL_WIDTH_MAX)).toBe(360)
    expect(toResponsiveWidthPreference(220, 2048, 460)).toBe(138)
    expect(resolveResponsiveWidth(138, 2048, 220, 460)).toBe(221)
  })
})

describe('workspace panel responsive layout', () => {
  it('reserves the floating-panel gutter without changing saved visible widths', () => {
    expect(FLOATING_PANEL_INLINE_GUTTER).toBe(16)
  })

  it('clamps a large preferred width to preserve a usable chat area', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: false,
      preferredWidth: 760,
    })).toMatchObject({
      width: 518,
      maxSplitWidth: 518,
      minChatWidth: 420,
      chatCollapseThreshold: 210,
    })
  })

  it('keeps the full preferred width when the sidebar is collapsed', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: true,
      preferredWidth: 760,
    })).toMatchObject({
      width: 760,
      maxSplitWidth: 842,
    })
  })

  it('adapts the readable chat threshold when a narrow window cannot fit 420px', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 800,
      sidebarWidth: 232,
      sidebarCollapsed: false,
      preferredWidth: 500,
    })).toMatchObject({
      width: WORKSPACE_PANEL_WIDTH_MIN,
      maxSplitWidth: WORKSPACE_PANEL_WIDTH_MIN,
      minChatWidth: 254,
      chatCollapseThreshold: 127,
    })
  })

  it('never returns a split panel narrower than the readable minimum', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 1200,
      sidebarWidth: 460,
      sidebarCollapsed: false,
      preferredWidth: 100,
    })).toMatchObject({
      width: WORKSPACE_PANEL_WIDTH_MIN,
      panelCollapseThreshold: WORKSPACE_PANEL_WIDTH_MIN / 2,
    })
  })

  it('allows a wide window to drag far beyond the old 760px cap', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 2048,
      sidebarWidth: 248,
      sidebarCollapsed: false,
      preferredWidth: WORKSPACE_PANEL_WIDTH_MAX,
    })).toMatchObject({
      width: 1346,
      maxSplitWidth: 1346,
      minChatWidth: 420,
      chatCollapseThreshold: 210,
    })
  })

  it('keeps the panel at its readable width throughout the right-side dead zone', () => {
    const layout = resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: false,
      preferredWidth: 360,
    })

    expect(resolveWorkspacePanelDrag(279, layout)).toEqual({ mode: 'split', width: 280 })
    expect(resolveWorkspacePanelDrag(140, layout)).toEqual({ mode: 'split', width: 280 })
    expect(resolveWorkspacePanelDrag(139, layout)).toEqual({ mode: 'collapsed', width: 280 })
  })

  it('keeps chat readable throughout the left-side dead zone before fullscreen', () => {
    const layout = resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: false,
      preferredWidth: 360,
    })

    expect(layout.maxSplitWidth).toBe(518)
    expect(resolveWorkspacePanelDrag(728, layout)).toEqual({ mode: 'split', width: 518 })
    expect(resolveWorkspacePanelDrag(729, layout)).toEqual({ mode: 'fullscreen', width: 518 })
  })

  it('uses exactly half of each readable first threshold for the second threshold', () => {
    const layout = resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: false,
      preferredWidth: 360,
    })

    expect(layout.panelCollapseThreshold).toBe(WORKSPACE_PANEL_WIDTH_MIN / 2)
    expect(layout.chatCollapseThreshold).toBe(layout.minChatWidth / 2)
  })

  it('reveals the collapsed panel from the full-height right-edge hotzone', () => {
    const coreLeft = 276
    const coreRight = 1280
    const revealStart = coreRight - WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH

    expect(isWorkspacePanelReopenHotzone(revealStart - 1, coreLeft, coreRight)).toBe(false)
    expect(isWorkspacePanelReopenHotzone(revealStart, coreLeft, coreRight)).toBe(true)
    expect(isWorkspacePanelReopenHotzone(coreRight, coreLeft, coreRight)).toBe(true)
    expect(isWorkspacePanelReopenHotzone(coreRight + 1, coreLeft, coreRight)).toBe(false)
  })
})

describe('workspace file navigator responsive layout', () => {
  it('keeps the compact legacy width until the user resizes it', () => {
    expect(resolveWorkspaceFileNavigatorLayout(720, WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT)).toEqual({
      width: 214,
      minWidth: WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
      maxWidth: 489,
      collapseThreshold: WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN / 2,
    })
  })

  it('caps a custom width so the file surface retains readable space', () => {
    expect(resolveWorkspaceFileNavigatorLayout(360, 480)).toMatchObject({
      width: 244,
      maxWidth: 244,
    })
  })

  it('never lets the navigator fully expand over the file surface', () => {
    const layout = resolveWorkspaceFileNavigatorLayout(600, WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX)

    expect(layout.maxWidth).toBe(Math.floor(600 * WORKSPACE_FILE_NAVIGATOR_MAX_RATIO))
    expect(layout.width).toBe(layout.maxWidth)
    expect(600 - layout.width).toBeGreaterThanOrEqual(192)
  })

  it('adapts below the nominal minimum only when the whole panel is narrow', () => {
    expect(resolveWorkspaceFileNavigatorLayout(230, 214)).toEqual({
      width: 134,
      minWidth: 134,
      maxWidth: 134,
      collapseThreshold: 67,
    })
  })

  it('uses the same readable dead zone before threshold collapse', () => {
    const layout = resolveWorkspaceFileNavigatorLayout(720, 286)

    expect(resolveWorkspaceFileNavigatorDrag(159, layout)).toEqual({ collapsed: false, width: 160 })
    expect(resolveWorkspaceFileNavigatorDrag(80, layout)).toEqual({ collapsed: false, width: 160 })
    expect(resolveWorkspaceFileNavigatorDrag(79, layout)).toEqual({ collapsed: true, width: 160 })
  })
})
