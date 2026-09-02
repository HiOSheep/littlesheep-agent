import { describe, expect, it } from 'vitest'
import { reduceCompletedRunMessages } from './run-result-reducer'

describe('completed assistant message metadata', () => {
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
