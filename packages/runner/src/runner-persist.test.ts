import { describe, expect, it, vi } from 'vitest'
import { asSessionId, textMessage, type AgentResult } from '@littlesheep/types'
import type { RunGitCheckpoint } from '@littlesheep/snapshot'
import type { ExecutionLogStore } from './execution-log.js'
import { persistRunnerPhase, RunnerPersistenceError } from './runner-persist.js'

function result(): AgentResult & { sessionId: ReturnType<typeof asSessionId> } {
  return {
    runId: 'persist-run',
    sessionId: asSessionId('persist-session'),
    status: 'ok',
    reply: 'reply',
    messages: [textMessage('assistant', 'reply')],
    trace: [],
    durationMs: 12,
  }
}

function logStore(overrides: Partial<Record<'write' | 'writeLatestForSession' | 'attachVersionCheckpoint', unknown>> = {}) {
  return {
    write: vi.fn(async () => undefined),
    writeLatestForSession: vi.fn(async () => undefined),
    attachVersionCheckpoint: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ExecutionLogStore
}

function checkpoint(overrides: Partial<{ complete: unknown; abort: unknown }> = {}) {
  return {
    complete: vi.fn(async () => ({ version: 1, id: 'checkpoint', status: 'complete' })),
    abort: vi.fn(async () => ({ version: 1, id: 'checkpoint', status: 'partial' })),
    ...overrides,
  } as unknown as RunGitCheckpoint
}

async function persist(options: Partial<Parameters<typeof persistRunnerPhase>[0]> = {}) {
  return persistRunnerPhase({
    result: result(),
    sessionId: asSessionId('persist-session'),
    startedAt: Date.now(),
    inputText: 'input',
    model: 'test/model',
    runtimeResourceObservation: undefined,
    executionLogStore: logStore(),
    onCheckpointCompleted: () => undefined,
    ...options,
  })
}

describe('persistRunnerPhase', () => {
  it('persists the actual run mode and structured runtime status', async () => {
    const store = logStore()
    const runtimeStatus = { version: 1 as const, status: 'waiting_user' as const, reason: 'effect_settlement_unknown' }
    await persist({ executionLogStore: store, durableHarnessMode: 'next', result: { ...result(), runtimeStatus } })
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({ durableHarnessMode: 'next', runtimeStatus }))
  })
  it('fails closed when the execution log write fails in strict mode', async () => {
    const store = logStore({ write: vi.fn(async () => { throw new Error('log unavailable') }) })
    await expect(persist({ executionLogStore: store, strict: true })).rejects.toMatchObject({
      name: 'RunnerPersistenceError',
      failures: ['execution_log'],
    })
    expect(store.writeLatestForSession).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the session summary write fails in strict mode', async () => {
    const store = logStore({
      writeLatestForSession: vi.fn(async () => { throw new Error('summary unavailable') }),
    })
    await expect(persist({ executionLogStore: store, strict: true })).rejects.toMatchObject({
      name: 'RunnerPersistenceError',
      failures: ['session_summary'],
    })
    expect(store.write).toHaveBeenCalledTimes(1)
  })

  it('reports version-checkpoint completion failure after preserving a partial checkpoint', async () => {
    const activeCheckpoint = checkpoint({
      complete: vi.fn(async () => { throw new Error('checkpoint unavailable') }),
    })
    let completed: boolean | undefined
    await expect(persist({
      activeCheckpoint,
      strict: true,
      onCheckpointCompleted: (value) => { completed = value },
    })).rejects.toMatchObject({
      name: 'RunnerPersistenceError',
      failures: ['version_checkpoint'],
    })
    expect(activeCheckpoint.complete).toHaveBeenCalledTimes(1)
    expect(activeCheckpoint.abort).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
  })

  it('reports every strict persistence failure in one bounded error', async () => {
    const store = logStore({
      write: vi.fn(async () => { throw new Error('log unavailable') }),
      writeLatestForSession: vi.fn(async () => { throw new Error('summary unavailable') }),
    })
    const activeCheckpoint = checkpoint({
      complete: vi.fn(async () => { throw new Error('checkpoint unavailable') }),
    })
    const error = await persist({
      executionLogStore: store,
      activeCheckpoint,
      strict: true,
    }).catch((value) => value)
    expect(error).toBeInstanceOf(RunnerPersistenceError)
    expect((error as RunnerPersistenceError).failures).toEqual([
      'execution_log',
      'session_summary',
      'version_checkpoint',
    ])
  })

  it('keeps legacy and shadow callers best-effort', async () => {
    const store = logStore({
      write: vi.fn(async () => { throw new Error('log unavailable') }),
      writeLatestForSession: vi.fn(async () => { throw new Error('summary unavailable') }),
    })
    const activeCheckpoint = checkpoint({
      complete: vi.fn(async () => { throw new Error('checkpoint unavailable') }),
    })
    let completed: boolean | undefined
    await expect(persist({
      executionLogStore: store,
      activeCheckpoint,
      strict: false,
      onCheckpointCompleted: (value) => { completed = value },
    })).resolves.toBeUndefined()
    expect(completed).toBe(true)
  })
})
