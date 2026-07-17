import { describe, expect, it } from 'vitest'
import { navigationSnapshotsEqual } from './navigation'
import type { AppNavigationSnapshot } from './types'

describe('application navigation snapshots', () => {
  it('treats the internal browser URL as part of global back and forward history', () => {
    const first = snapshot({ workspaceBrowserUrl: 'https://example.com/first' })
    const second = snapshot({ workspaceBrowserUrl: 'https://example.com/second' })

    expect(navigationSnapshotsEqual(first, first)).toBe(true)
    expect(navigationSnapshotsEqual(first, second)).toBe(false)
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
    workspaceBrowserUrl: '',
    workspaceOpenRequest: null,
    workspaceFileNavigatorCollapsed: false,
    workspaceExpandedPaths: [],
    ...overrides,
  }
}
