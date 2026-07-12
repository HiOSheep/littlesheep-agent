import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_PANEL_REOPEN_HOTZONE_WIDTH,
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  isWorkspacePanelReopenHotzone,
  resolveWorkspacePanelDrag,
  resolveWorkspacePanelLayout,
} from './workspace-layout'

describe('workspace panel responsive layout', () => {
  it('clamps a large preferred width to preserve a usable chat area', () => {
    expect(resolveWorkspacePanelLayout({
      viewportWidth: 1280,
      sidebarWidth: 308,
      sidebarCollapsed: false,
      preferredWidth: 760,
    })).toMatchObject({
      width: 550,
      maxSplitWidth: 550,
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
      maxSplitWidth: 858,
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
      minChatWidth: 286,
      chatCollapseThreshold: 143,
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
      width: 1378,
      maxSplitWidth: 1378,
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

    expect(layout.maxSplitWidth).toBe(550)
    expect(resolveWorkspacePanelDrag(759, layout)).toEqual({ mode: 'split', width: 550 })
    expect(resolveWorkspacePanelDrag(760, layout)).toEqual({ mode: 'split', width: 550 })
    expect(resolveWorkspacePanelDrag(761, layout)).toEqual({ mode: 'fullscreen', width: 550 })
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
