import { describe, expect, it } from 'vitest'
import { reduceCompletedRunMessages } from './run-result-reducer'
import { executionLogToHistoryActivity } from '../../shared/history-activity'
import { buildTaskProgress } from '../task-progress'
import type { ChatMessage } from './types'
import type { ExecutionLog } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'

describe('completed assistant message metadata', () => {
  const preview = (): ChatMessage[] => [{ role: 'assistant', text: 'preview', activity: {
    status: 'running', instruction: 'task', startedAt: 1_000,
    steps: [{ stepId: 'step-1', title: 'step', status: 'running', activeTools: 1, toolCount: 1 }],
    tools: [{ callId: 'call-1', name: 'read', startedAt: 1_001, output: 'live output' }],
  } }]

  it('reconciles missing stream completion events by step and call identity', () => {
    const result = {
      runId: 'r', sessionId: 's', status: 'ok' as const, reply: 'final', durationMs: 100,
      taskExecution: { goal: 'task', complexity: 'simple', status: 'done', startedAt: '2026-09-11T00:00:00Z',
        steps: [{ stepId: 'step-1', description: 'step', status: 'done', startedAt: '2026-09-11T00:00:00Z', toolCallIds: ['call-1'] }] },
      toolInvocations: [{ version: 1 as const, id: 'inv-1', callId: 'call-1', runId: 'r', sessionId: asSessionId('s'),
        toolName: 'read', toolSource: 'builtin', status: 'succeeded' as const, proposedAt: '2026-09-11T00:00:00Z',
        approval: { required: false, decision: 'not_required' as const }, evidenceIds: [], outputSummary: 'verified output' }],
    }
    const message = reduceCompletedRunMessages(preview(), result)[0]!
    expect(message.text).toBe('final')
    // The durable record supplies status/end time; the visible output stays
    // exactly what the live stream already showed.
    expect(message.activity).toMatchObject({ status: 'done', steps: [{ status: 'done', activeTools: 0 }],
      tools: [{ callId: 'call-1', ok: true, output: 'live output', startedAt: 1_001 }] })
    expect(JSON.stringify(message.activity?.tools)).not.toContain('output present')
    expect(reduceCompletedRunMessages([message], result)[0]?.activity?.tools).toHaveLength(1)
  })

  it('keeps waiting-user state and reason identical across live completion and history reload', () => {
    const runtimeStatus = { version: 1 as const, status: 'waiting_user' as const, reason: 'effect_settlement_unknown' }
    const result = { runId: 'r', sessionId: 's', status: 'error' as const, reply: '', durationMs: 100,
      runtimeStatus, runCheckpointId: 'checkpoint-r', error: '需要确认写入结果。' }
    const live = reduceCompletedRunMessages(preview(), result)[0]!.activity!
    const history = executionLogToHistoryActivity({ ...result, inboundText: 'task', model: 'test',
      startedAt: '2026-09-11T00:00:00Z', endedAt: '2026-09-11T00:00:01Z', trace: [], toolCalls: [] } as ExecutionLog)
    for (const activity of [live, history]) {
      expect(activity).toMatchObject({ status: 'waiting_user', error: result.error, runtimeStatus, runCheckpointId: 'checkpoint-r' })
      expect(buildTaskProgress(activity)).toMatchObject({ phase: 'waiting_user', label: '等待用户决定' })
    }
    expect(live.steps[0]).toMatchObject({ status: 'pending', activeTools: 0 })
  })

  it('ends stale activity without inventing successful tool or step outcomes', () => {
    const activity = reduceCompletedRunMessages(preview(), {
      runId: 'r', sessionId: 's', status: 'error', reply: '', durationMs: 10,
    })[0]!.activity!
    expect(activity.steps[0]).toMatchObject({ status: 'unknown', activeTools: 0 })
    expect(activity.tools[0]?.ok).toBeUndefined()
    expect(activity.tools[0]?.endedAt).toBeTypeOf('number')
    expect(activity.tools[0]?.error).toBeTruthy()
  })
  it('records the assistant completion time separately from the user turn time', () => {
    const messages = reduceCompletedRunMessages([
      {
        role: 'assistant',
        text: '完成中的回答',
        timestamp: '2026-08-25T09:00:00.000Z',
        activity: {
          status: 'running',
          instruction: '执行任务',
          startedAt: 1_000,
          steps: [],
          tools: [],
        },
      },
    ], {
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'ok',
      reply: '完成中的回答',
      durationMs: 100,
    })

    expect(messages[0]?.timestamp).not.toBe('2026-08-25T09:00:00.000Z')
    expect(Date.parse(messages[0]?.timestamp ?? '')).not.toBeNaN()
  })

  it('attaches only the bounded Web evidence projection to the completed turn', () => {
    const messages = reduceCompletedRunMessages([{ role: 'assistant', text: '', activity: {
      status: 'running', instruction: '查资料', startedAt: 1_000, steps: [], tools: [],
    } }], {
      runId: 'run-web', sessionId: 'session-web', status: 'ok', reply: '已查证。', durationMs: 100,
      webEvidence: {
        version: 1, providerId: 'fake', generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'partial',
        citationIds: ['web-run-source'], citationCount: 1, documentCount: 1, cached: true,
        partial: true, truncated: false, blocked: false, stale: false,
      },
    })

    expect(messages[0]?.webEvidence).toMatchObject({ citationIds: ['web-run-source'], partial: true, cached: true })
    expect(JSON.stringify(messages[0])).not.toContain('page body')
  })
})
