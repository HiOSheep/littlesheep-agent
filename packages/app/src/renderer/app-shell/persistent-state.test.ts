import { describe, expect, it } from 'vitest'
import {
  createDefaultPersistedAppShellState,
  hydratePersistedAppShellState,
  restoreComposerDraft,
} from './persistent-state'

describe('persistent application shell state', () => {
  it('restores stable route, sidebar and composer state', () => {
    expect(hydratePersistedAppShellState({
      version: 1,
      route: { section: 'settings', page: 'browser' },
      conversationCollapsed: true,
      sidebarPanel: 'search',
      sidebarSearch: 'memory',
      composerDraft: 'unfinished message',
      composerSessionId: 'session-1',
      permissionMode: 'full-access',
      pendingApproval: { approved: true },
    })).toEqual({
      version: 1,
      route: { section: 'settings', page: 'browser' },
      conversationCollapsed: true,
      sidebarPanel: null,
      sidebarSearch: 'memory',
      composerDraft: 'unfinished message',
      composerSessionId: 'session-1',
    })
  })

  it('restores direct module pages and search only on the chat surface', () => {
    expect(hydratePersistedAppShellState({
      version: 1,
      route: { section: 'module', page: 'memoryTree' },
      sidebarPanel: 'search',
    }).route).toEqual({ section: 'module', page: 'memoryTree' })
    expect(hydratePersistedAppShellState({
      version: 1,
      route: { section: 'chat' },
      sidebarPanel: 'search',
    }).sidebarPanel).toBe('search')
  })

  it('fails closed for malformed or newer snapshots', () => {
    expect(hydratePersistedAppShellState({ version: 2, route: { section: 'settings', page: 'api' } }))
      .toEqual(createDefaultPersistedAppShellState())
    expect(hydratePersistedAppShellState({ version: 1, route: { section: 'settings', page: 'unknown' } }).route)
      .toEqual({ section: 'chat' })
  })

  it('does not move an unfinished composer draft into another conversation', () => {
    const state = hydratePersistedAppShellState({
      version: 1,
      route: { section: 'chat' },
      composerDraft: 'session A draft',
      composerSessionId: 'session-a',
    })
    expect(restoreComposerDraft(state, 'session-a')).toBe('session A draft')
    expect(restoreComposerDraft(state, 'session-b')).toBe('')
    expect(restoreComposerDraft(state, null)).toBe('')
  })
})
