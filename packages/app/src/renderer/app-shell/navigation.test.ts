import { describe, expect, it } from 'vitest'
import { navigationSnapshotsEqual } from './navigation'
import type { AppNavigationSnapshot } from './types'

describe('application navigation snapshots', () => {
  it('does not mix embedded browser history into global back and forward history', () => {
    const first = snapshot()
    const second = snapshot()

    expect(navigationSnapshotsEqual(first, first)).toBe(true)
    expect(navigationSnapshotsEqual(first, second)).toBe(true)
  })
})

function snapshot(overrides: Partial<AppNavigationSnapshot> = {}): AppNavigationSnapshot {
  return {
    route: { section: 'chat' },
    sidebarCollapsed: false,
    sidebarWidth: 280,
    conversationCollapsed: false,
    sidebarPanel: null,
    workspacePanelCollapsed: false,
    workspacePanelFullscreen: false,
    workspacePanelWidth: 480,
    workspacePanelTab: 'browser',
    workspacePanelOpenTabs: ['browser'],
    workspaceOpenRequest: null,
    workspaceFileNavigatorCollapsed: false,
    workspaceExpandedPaths: [],
    ...overrides,
  }
}
