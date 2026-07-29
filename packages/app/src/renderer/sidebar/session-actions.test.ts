import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionMessagePage } from '../api'
import { createSessionActions, type SessionActionContext } from './session-actions'

vi.mock('../api', () => ({
  deleteSession: vi.fn(),
  getSessionMessagePage: vi.fn(),
  updateRuntime: vi.fn(),
}))

const mockedGetSessionMessagePage = vi.mocked(getSessionMessagePage)

function createSwitchContext(overrides: Partial<SessionActionContext> = {}): SessionActionContext {
  return {
    abortRef: { current: null },
    activeApprovalScopeKey: () => 'session:test',
    alignWorkspacePanelToWorkspaceRoot: vi.fn(),
    appMountedRef: { current: true },
    approvalGrantsRef: { current: {} },
    beginDraftApprovalScope: vi.fn(),
    currentSession: undefined,
    pushRoute: vi.fn(),
    refreshProjects: vi.fn(async () => undefined),
    refreshRuntime: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => []),
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
    sessionOwnership: { scope: 'standalone' },
    visibleSessions: [],
    ...overrides,
  } as SessionActionContext
}

describe('session switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetSessionMessagePage.mockResolvedValue({ messages: [], hasMore: false })
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
    expect(mockedGetSessionMessagePage).toHaveBeenCalledWith('session-1', { limit: 120 })
    expect(context.setMessages).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: 'assistant', text: '恢复后的结果' }),
    ])
  })
})
