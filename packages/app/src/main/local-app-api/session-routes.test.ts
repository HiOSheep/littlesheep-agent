import { describe, expect, it } from 'vitest'
import type { ExecutionLog } from '@littlesheep/runner'
import { buildSessionContextUsageRecord } from './session-routes.js'

function usageLog(input: {
  sessionId: string
  runId: string
  model: string
  promptTokens: number
  endedAt: string
}): ExecutionLog {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    model: input.model,
    startedAt: input.endedAt,
    endedAt: input.endedAt,
    usage: {
      promptTokens: input.promptTokens,
      completionTokens: 10,
      source: 'provider',
    },
  } as ExecutionLog
}

describe('session context usage history projection', () => {
  it('restores only the newest count belonging to the requested session', () => {
    const record = buildSessionContextUsageRecord([
      usageLog({
        sessionId: 'session-current',
        runId: 'run-old',
        model: 'openai/gpt-5.5',
        promptTokens: 120,
        endedAt: '2026-08-25T09:00:00.000Z',
      }),
      usageLog({
        sessionId: 'session-current',
        runId: 'run-new',
        model: 'openai/gpt-5.5',
        promptTokens: 240,
        endedAt: '2026-08-25T09:02:00.000Z',
      }),
      usageLog({
        sessionId: 'session-other',
        runId: 'run-foreign',
        model: 'openai/gpt-5.5',
        promptTokens: 9_999,
        endedAt: '2026-08-25T09:03:00.000Z',
      }),
    ], 'session-current')

    expect(record).toMatchObject({
      modelRef: 'openai/gpt-5.5',
      usage: { promptTokens: 240 },
    })
  })

  it('does not fabricate a count when the session has no displayable usage', () => {
    expect(buildSessionContextUsageRecord([
      { sessionId: 'session-empty', runId: 'run-empty', startedAt: '2026-08-25T09:00:00.000Z', endedAt: '2026-08-25T09:00:00.000Z' } as ExecutionLog,
    ], 'session-empty')).toBeUndefined()
  })
})
