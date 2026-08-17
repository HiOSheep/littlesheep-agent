import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSession, getSessionMessagePage } from '../api'
import { createSessionActions, type SessionActionContext } from './session-actions'

vi.mock('../api', () => ({
  deleteSession: vi.fn(),
  getSessionMessagePage: vi.fn(),
  updateRuntime: vi.fn(),
}))

const mockedGetSessionMessagePage = vi.mocked(getSessionMessagePage)
const mockedDeleteSession = vi.mocked(deleteSession)

function createSwitchContext(overrides: Partial<SessionActionContext> = {}): SessionActionContext {
  return {
    abortRef: { current: null },
    alignWorkspacePanelToWorkspaceRoot: vi.fn(),
    appMountedRef: { current: true },
    approvalGrantsRef: { current: { clear: vi.fn() } },
    beginDraftApprovalScope: vi.fn(),
    currentSession: undefined,
    pushRoute: vi.fn(),
    refreshProjects: vi.fn(async () => undefined),
    refreshRuntime: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => []),
    removeWorkspaceSessionLayout: vi.fn(),
    resetWorkspaceSessionLayout: vi.fn(),
    runtime: null,
    sessionLoadRequestRef: { current: 0 },
    historyLoadRequestRef: { current: 0 },
    historyWindow: { hasMore: false, loading: false },
    sessions: [],
    setContextUsageSnapshot: vi.fn(),
    setConversationCollapsed: vi.fn(),
    setControlTip: vi.fn(),
    setCurrentSession: vi.fn(),
    setMessages: vi.fn(),
    setHistoryWindow: vi.fn(),
    setPinnedSessionIds: vi.fn(),
    setRuntime: vi.fn(),
    setRuntimeError: vi.fn(),
    setSessionOwnership: vi.fn(),
    setSessions: vi.fn(),
    setSidebarPanel: vi.fn(),
    settleApprovalPrompt: vi.fn(),
    visibleSessions: [],
    ...overrides,
  } as SessionActionContext
}

describe('session switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetSessionMessagePage.mockResolvedValue({ messages: [], hasMore: false })
    mockedDeleteSession.mockResolvedValue(undefined)
  })

  it('keeps history loading out of the shared composer error surface', async () => {
    const context = createSwitchContext()
    const { switchSession } = createSessionActions(context)

    await switchSession({
      id: 'session-2',
      title: '第二个会话',
      createdAt: 1,
      lastMessageAt: 2,
      mode: 'general',
      scope: 'standalone',
    })

    expect(context.setHistoryWindow).toHaveBeenCalledWith({ hasMore: false, beforeId: undefined, loading: true })
    expect(context.setRuntimeError).not.toHaveBeenCalledWith('正在加载历史消息...')
    expect(context.setRuntimeError).toHaveBeenCalledWith(null)
    expect(context.setContextUsageSnapshot).toHaveBeenCalledWith(null)
  })

  it('force reloads the active session after checkpoint recovery without aborting the completed stream', async () => {
    const abort = vi.fn()
    const context = createSwitchContext({
      abortRef: { current: { abort } as unknown as AbortController },
      currentSession: 'session-1',
    })
    mockedGetSessionMessagePage.mockResolvedValue({
      messages: [{
        id: 'message-1',
        role: 'assistant',
        text: '恢复后的结果',
        timestamp: '2026-07-29T10:00:00.000Z',
      }],
      hasMore: false,
    })
    const { switchSession } = createSessionActions(context)

    await switchSession({
      id: 'session-1',
      title: '当前会话',
      createdAt: 1,
      lastMessageAt: 2,
      mode: 'general',
      scope: 'standalone',
    }, { forceReload: true })

    expect(abort).not.toHaveBeenCalled()
    expect(context.setCurrentSession).not.toHaveBeenCalled()
    expect(context.setContextUsageSnapshot).not.toHaveBeenCalled()
    expect(mockedGetSessionMessagePage).toHaveBeenCalledWith('session-1', { limit: 120 })
    expect(context.setMessages).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: 'assistant', text: '恢复后的结果' }),
    ])
  })

  it('keeps older-message pagination available after switching sessions', async () => {
    const context = createSwitchContext({
      currentSession: 'session-1',
      historyWindow: { hasMore: true, beforeId: 'cursor-1', loading: false },
    })
    mockedGetSessionMessagePage
      .mockResolvedValueOnce({ messages: [], hasMore: false })
      .mockResolvedValueOnce({
        messages: [{
          id: 'older-1',
          role: 'user',
          text: '更早消息',
          timestamp: '2026-08-14T10:00:00.000Z',
        }],
        hasMore: false,
      })
    const actions = createSessionActions(context)

    await actions.switchSession({
      id: 'session-1',
      title: '当前会话',
      createdAt: 1,
      lastMessageAt: 2,
      mode: 'general',
      scope: 'standalone',
    }, { forceReload: true })

    await expect(actions.loadOlderMessages()).resolves.toBe(true)
    expect(mockedGetSessionMessagePage).toHaveBeenLastCalledWith('session-1', {
      limit: 120,
      beforeId: 'cursor-1',
    })
  })

  it('invalidates late history and stream results when archiving the active session', async () => {
    const abort = vi.fn()
    const context = createSwitchContext({
      abortRef: { current: { abort } as unknown as AbortController },
      currentSession: 'session-1',
    })
    const { archiveSession } = createSessionActions(context)

    await archiveSession('session-1')

    expect(mockedDeleteSession).toHaveBeenCalledWith('session-1')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(context.sessionLoadRequestRef.current).toBe(1)
    expect(context.historyLoadRequestRef.current).toBe(0)
    expect(context.setCurrentSession).toHaveBeenCalledWith(undefined)
    expect(context.setContextUsageSnapshot).toHaveBeenCalledWith(null)
  })
})
