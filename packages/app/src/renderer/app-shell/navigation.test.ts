import { describe, expect, it } from 'vitest'
import { navigationSnapshotOwnsWorkspace, navigationSnapshotsEqual } from './navigation'
import type { AppNavigationSnapshot } from './types'

describe('application navigation snapshots', () => {
  it('does not mix embedded browser history into global back and forward history', () => {
    const first = snapshot()
    const second = snapshot()

    expect(navigationSnapshotsEqual(first, first)).toBe(true)
    expect(navigationSnapshotsEqual(first, second)).toBe(true)
  })

  it('keeps workspace history scoped to the conversation that created it', () => {
    const sessionA = snapshot({ workspaceScopeKey: 'session:a' })
    const sessionB = snapshot({ workspaceScopeKey: 'session:b' })

    expect(navigationSnapshotsEqual(sessionA, sessionB)).toBe(false)
    expect(navigationSnapshotOwnsWorkspace(sessionA, 'session:a')).toBe(true)
    expect(navigationSnapshotOwnsWorkspace(sessionA, 'session:b')).toBe(false)
  })
})

function snapshot(overrides: Partial<AppNavigationSnapshot> = {}): AppNavigationSnapshot {
  return {
    route: { section: 'chat' },
    workspaceScopeKey: 'session:test',
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
