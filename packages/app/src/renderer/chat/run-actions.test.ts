import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEventIngressOutcome } from '@littlesheep/types'
import { createRunActions, type RunActionContext } from './run-actions'
import type { ChatMessage } from './types'


const apiMocks = vi.hoisted(() => ({
  runAgentStream: vi.fn(),
  sendRuntimeControlEvent: vi.fn(),
  sendRuntimeTaskEvent: vi.fn(),
}))


vi.mock('../api', () => apiMocks)


describe('run actions active-run updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues a running user update without starting a second run', async () => {
    apiMocks.sendRuntimeTaskEvent.mockResolvedValue(outcome('accepted'))
    const fixture = contextFixture('add verification', 'run-1')

    await createRunActions(fixture.context).send()

    expect(apiMocks.runAgentStream).not.toHaveBeenCalled()
    expect(apiMocks.sendRuntimeTaskEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'user_message',
      text: 'add verification',
      id: expect.any(String),
      dedupKey: expect.any(String),
    }))
    expect(fixture.input()).toBe('')
    expect(fixture.messages()).toContainEqual(expect.objectContaining({
      id: apiMocks.sendRuntimeTaskEvent.mock.calls[0]?.[1].id,
      role: 'user',
      text: 'add verification',
    }))
    expect(fixture.notices.at(-1)).toMatchObject({ tone: 'success' })
  })

  it('preserves input when the active queue rejects the update', async () => {
    apiMocks.sendRuntimeTaskEvent.mockResolvedValue(rejected('capacity'))
    const fixture = contextFixture('do not lose this', 'run-1')

    await createRunActions(fixture.context).send()

    expect(fixture.input()).toBe('do not lose this')
    expect(fixture.notices.at(-1)).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('队列已满'),
    })
  })

  it('reuses the same event identity after an uncertain transport failure', async () => {
    apiMocks.sendRuntimeTaskEvent
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(outcome('duplicate'))
    const fixture = contextFixture('retry safely', 'run-1')
    const actions = createRunActions(fixture.context)

    await actions.send()
    await actions.send()

    const firstRequest = apiMocks.sendRuntimeTaskEvent.mock.calls[0]?.[1]
    const secondRequest = apiMocks.sendRuntimeTaskEvent.mock.calls[1]?.[1]
    expect(firstRequest).toMatchObject({ id: expect.any(String), dedupKey: expect.any(String) })
    expect(secondRequest).toMatchObject({
      id: firstRequest?.id,
      dedupKey: firstRequest?.dedupKey,
    })
    expect(fixture.input()).toBe('')
    expect(fixture.messages().filter((message) => message.text === 'retry safely')).toHaveLength(1)
  })

  it('keeps the update visible while the run identity is still starting', async () => {
    const fixture = contextFixture('wait for startup', null)

    await createRunActions(fixture.context).send()

    expect(apiMocks.sendRuntimeTaskEvent).not.toHaveBeenCalled()
    expect(fixture.input()).toBe('wait for startup')
    expect(fixture.notices.at(-1)?.text).toContain('仍在启动')
  })

  it('does not send a new conversation message to an aborted previous run', async () => {
    const fixture = contextFixture('belongs to session B', 'run-session-a')
    const controller = new AbortController()
    controller.abort()
    fixture.context.abortRef.current = controller

    await createRunActions(fixture.context).send()

    expect(apiMocks.sendRuntimeTaskEvent).not.toHaveBeenCalled()
    expect(fixture.input()).toBe('belongs to session B')
  })

  it('restores idle-run input and attachments when continuation binding is blocked', async () => {
    const blocked = new Error('multiple waiting tasks require explicit selection')
    blocked.name = 'RunStreamServerError'
    apiMocks.runAgentStream.mockRejectedValue(blocked)
    const attachment = {
      path: 'C:\\managed\\source.pdf',
      name: 'source.pdf',
      kind: 'document' as const,
      cacheId: 'cache-1',
    }
    const fixture = contextFixture('do not lose this turn', null, {
      loading: false,
      attachments: [attachment],
    })

    await createRunActions(fixture.context).send()

    expect(apiMocks.runAgentStream).toHaveBeenCalledOnce()
    expect(apiMocks.runAgentStream.mock.calls[0]?.[4]).toMatchObject({
      attachments: [attachment],
      requestKey: expect.any(String),
    })
    expect(fixture.input()).toBe('do not lose this turn')
    expect(fixture.attachments()).toEqual([attachment])
  })

  it('reuses the same conversation request key after an uncertain stream transport failure', async () => {
    apiMocks.runAgentStream.mockRejectedValue(new Error('connection closed before result'))
    const fixture = contextFixture('retry the same turn safely', null, { loading: false })
    const actions = createRunActions(fixture.context)

    await actions.send()
    await actions.send()

    const firstOptions = apiMocks.runAgentStream.mock.calls[0]?.[4]
    const retryOptions = apiMocks.runAgentStream.mock.calls[1]?.[4]
    expect(firstOptions?.requestKey).toEqual(expect.any(String))
    expect(retryOptions?.requestKey).toBe(firstOptions?.requestKey)
    expect(fixture.context.pendingConversationTurnRef.current).toMatchObject({
      requestKey: firstOptions?.requestKey,
    })
    expect(fixture.input()).toBe('retry the same turn safely')
  })

  it('does not publish a stopped conversation into a newly selected conversation view', async () => {
    let rejectRun!: (error: Error) => void
    apiMocks.runAgentStream.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRun = reject
    }))
    const fixture = contextFixture('session A message', null, { loading: false })

    const pending = createRunActions(fixture.context).send()
    await vi.waitFor(() => expect(apiMocks.runAgentStream).toHaveBeenCalledOnce())
    fixture.context.conversationViewRequestRef.current += 1
    const aborted = new Error('stopped after switching conversations')
    aborted.name = 'AbortError'
    rejectRun(aborted)
    await pending

    expect(fixture.context.setMessages).toHaveBeenCalledTimes(1)
    expect(fixture.context.setContextUsageSnapshot).not.toHaveBeenCalled()
    expect(fixture.input()).toBe('')
    expect(fixture.context.setLoading).toHaveBeenLastCalledWith(false)
  })

  it('keeps one interrupt request per run', async () => {
    apiMocks.sendRuntimeControlEvent.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const fixture = contextFixture('', 'run-1', { loading: true })
    fixture.context.abortRef.current = controller
    const actions = createRunActions(fixture.context)

    actions.stop()
    actions.stop()

    expect(apiMocks.sendRuntimeControlEvent).toHaveBeenCalledOnce()
    expect(apiMocks.sendRuntimeControlEvent).toHaveBeenCalledWith('run-1', 'interrupt_requested', 'user-requested-stop')
    expect(controller.signal.aborted).toBe(false)
  })

  it('aborts the local stream when Runtime rejects the interrupt', async () => {
    apiMocks.sendRuntimeControlEvent.mockResolvedValue({ kind: 'rejected', reason: 'run-not-active', message: 'gone' })
    const controller = new AbortController()
    const fixture = contextFixture('', 'run-1', { loading: true })
    fixture.context.abortRef.current = controller

    createRunActions(fixture.context).stop()
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
  })

  it('aborts the local stream when the interrupt request itself fails', async () => {
    apiMocks.sendRuntimeControlEvent.mockRejectedValue(new Error('bridge unavailable'))
    const controller = new AbortController()
    const fixture = contextFixture('', 'run-1', { loading: true })
    fixture.context.abortRef.current = controller

    createRunActions(fixture.context).stop()
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
  })

  it('does not reach Runtime for a stop with no run identity', () => {
    const fixture = contextFixture('', null, { loading: false })

    createRunActions(fixture.context).stop()

    expect(apiMocks.sendRuntimeControlEvent).not.toHaveBeenCalled()
  })

  it('settles public reasoning when the visible stream aborts locally', async () => {
    const aborted = new Error('stopped locally')
    aborted.name = 'AbortError'
    apiMocks.runAgentStream.mockRejectedValue(aborted)
    const fixture = contextFixture('stop this run', null, { loading: false })

    await createRunActions(fixture.context).send()

    const activity = fixture.messages().at(-1)?.activity
    expect(activity).toMatchObject({
      status: 'aborted',
      visibility: 'progress',
      error: '本次运行已停止。',
    })
    expect(activity?.reasoning).toEqual([
      expect.objectContaining({ phaseId: 'request:dispatch', activityKind: 'request_dispatch', status: 'aborted', endedAt: expect.any(Number) }),
    ])
  })

  // CE-09: a failure has to stay visible. The composer must leave the running
  // state and the turn must carry the Runtime's own reason — never a canned
  // Agent apology, and never a streamed preview left standing as if it were the
  // answer.
  it.each([
    ['a definitive stream rejection', (() => {
      const error = new Error('provider request failed: 502')
      error.name = 'RunStreamServerError'
      return error
    })()],
    ['a stream that ended without a result', new Error('Local app API stream ended without result')],
    ['a runtime error frame', (() => {
      const error = new Error('runtime could not settle the final reply')
      error.name = 'RunStreamServerError'
      return error
    })()],
  ])('surfaces %s as a terminal failure without inventing an answer', async (_label, failure) => {
    apiMocks.runAgentStream.mockImplementation(async (_text, _session, _mode, handlers: { onDelta: (delta: string) => void }) => {
      handlers.onDelta('partial preview ')
      throw failure
    })
    const fixture = contextFixture('做一个小游戏吧', null, { loading: false })

    await createRunActions(fixture.context).send()

    const message = fixture.messages().at(-1)
    expect(message?.text).toBe('')
    expect(message?.activity).toMatchObject({
      status: 'failed',
      error: (failure as Error).message,
    })
    expect(message?.activity?.endedAt).toBeTypeOf('number')
    // Serialized form carries no apology-style substitute for a model reply.
    expect(JSON.stringify(message)).not.toMatch(/抱歉|sorry,/i)
    // The turn is not lost and the composer is usable again.
    expect(fixture.input()).toBe('做一个小游戏吧')
    expect(fixture.context.setLoading).toHaveBeenLastCalledWith(false)
  })
})


function contextFixture(
  initialInput: string,
  runId: string | null,
  options: { loading?: boolean; attachments?: RunActionContext['attachments'] } = {},
) {
  let input = initialInput
  let currentAttachments = options.attachments ?? []
  let currentMessages: ChatMessage[] = []
  const notices: Array<{ tone: string; text: string } | null> = []
  const context = {
    abortRef: { current: null },
    activeRunIdRef: { current: runId },
    activeApprovalScopeKey: () => 'draft',
    appMountedRef: { current: true },
    approvalGrantsRef: { current: {} },
    attachments: currentAttachments,
    conversationViewRequestRef: { current: 0 },
    currentSession: 'session-1',
    input: initialInput,
    liveToolStepRef: { current: new Map() },
    loading: options.loading ?? true,
    permissionMode: 'research',
    pendingRuntimeMessageRef: { current: null },
    pendingConversationTurnRef: { current: null },
    publishRuntimeEventNotice: (notice: { tone: string; text: string } | null) => notices.push(notice),
    refreshProjects: vi.fn(),
    refreshSessions: vi.fn(),
    requestApprovalForScope: vi.fn(),
    runtime: null,
    sessionOwnership: { scope: 'standalone' },
    setActivityNow: vi.fn(),
    setAttachments: vi.fn((next: RunActionContext['attachments'] | ((current: RunActionContext['attachments']) => RunActionContext['attachments'])) => {
      currentAttachments = typeof next === 'function' ? next(currentAttachments) : next
    }),
    setContextUsageSnapshot: vi.fn(),
    setCurrentSession: vi.fn(),
    setInput: vi.fn((next: string | ((current: string) => string)) => {
      input = typeof next === 'function' ? next(input) : next
    }),
    setLoading: vi.fn(),
    setMessages: vi.fn((next: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
      currentMessages = typeof next === 'function' ? next(currentMessages) : next
    }),
    setWorkspaceArtifactVersion: vi.fn(),
    settleApprovalPrompt: vi.fn(),
    stopRequestedRunIdRef: { current: null },
  } as unknown as RunActionContext
  return {
    context,
    input: () => input,
    attachments: () => currentAttachments,
    messages: () => currentMessages,
    notices,
  }
}


function outcome(kind: 'accepted' | 'duplicate'): RuntimeEventIngressOutcome {
  return {
    kind,
    event: {
      version: 1,
      id: `event-${kind}`,
      runId: 'run-1',
      sessionId: 'session-1' as never,
      sequence: 1,
      type: 'user_message',
      source: 'app',
      status: 'queued',
      receivedAt: '2026-07-29T00:00:00.000Z',
      payload: { text: 'update' },
    },
  }
}


function rejected(reason: Extract<RuntimeEventIngressOutcome, { kind: 'rejected' }>['reason']): RuntimeEventIngressOutcome {
  return { kind: 'rejected', reason, message: `rejected: ${reason}` }
}
