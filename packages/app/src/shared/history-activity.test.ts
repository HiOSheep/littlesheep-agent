import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLogStore, type ExecutionLog } from '@littlesheep/runner'
import type { Message } from '@littlesheep/types'
import { buildHistoryMessages } from './history-activity.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executionLog(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    startedAt: '2026-07-11T01:00:00.000Z',
    endedAt: '2026-07-11T01:00:04.000Z',
    status: 'ok',
    model: 'test/model',
    inboundText: 'Read the project file',
    reply: 'The file uses pnpm.',
    trace: [],
    taskExecution: {
      goal: 'Read the project file',
      complexity: 'simple',
      status: 'done',
      startedAt: '2026-07-11T01:00:00.100Z',
      endedAt: '2026-07-11T01:00:03.900Z',
      summary: 'The file uses pnpm.',
      steps: [{
        stepId: 'step-1',
        title: 'Read file',
        description: 'Read the requested project file',
        status: 'done',
        startedAt: '2026-07-11T01:00:00.200Z',
        endedAt: '2026-07-11T01:00:03.500Z',
        output: 'packageManager: pnpm',
        toolCallIds: ['call-1'],
        toolResults: [{ callId: 'call-1', ok: true, output: 'packageManager: pnpm', durationMs: 25 }],
      }],
    },
    toolCalls: [{
      call: { id: 'call-1', name: 'read', input: { path: 'package.json' } },
      result: {
        callId: 'call-1',
        ok: true,
        output: { packageManager: 'pnpm' },
        durationMs: 25,
        meta: { stepId: 'step-1' },
      },
    }],
    durationMs: 4_000,
    ...overrides,
  }
}

describe('durable history activity reconstruction', () => {
  it('restores bounded Web source metadata without any live retrieval', () => {
    const log = executionLog({
      webEvidence: {
        version: 1, providerId: 'fake', generatedAt: '2026-08-29T00:00:00.000Z', completeness: 'complete',
        citationIds: ['web-run-source'], citationCount: 1, documentCount: 1, cached: false,
        partial: false, truncated: false, blocked: false, stale: false,
        citations: [{
          id: 'web-run-source', origin: 'https://example.com', urlHash: 'a'.repeat(64),
          title: 'Public source', fetchedAt: '2026-08-29T00:00:00.000Z', status: 'fetched', truncated: false,
        }],
      },
    })
    const messages: Message[] = [{
      id: 'assistant-final', role: 'assistant', runId: 'run-1', stage: 'finalize',
      timestamp: log.endedAt, content: [{ type: 'text', text: log.reply }],
    }]

    const history = buildHistoryMessages(messages, new Map([['run-1', log]]))

    expect(history[0]?.webEvidence).toMatchObject({ citationIds: ['web-run-source'] })
    expect(JSON.stringify(history)).not.toContain('query')
  })

  it('attaches one recovered process to the final assistant message for a run', () => {
    const messages: Message[] = [
      {
        id: 'user-1', role: 'user', runId: 'run-1', timestamp: '2026-07-11T01:00:00.000Z',
        content: [{ type: 'text', text: 'Read the project file' }],
      },
      {
        id: 'assistant-tool', role: 'assistant', runId: 'run-1', stage: 'execute',
        timestamp: '2026-07-11T01:00:01.000Z',
        content: [{ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', input: { path: 'package.json' } }] }],
      },
      {
        id: 'tool-1', role: 'tool', runId: 'run-1', stage: 'execute',
        timestamp: '2026-07-11T01:00:02.000Z',
        content: [{ type: 'tool_result', result: { callId: 'call-1', ok: true, output: 'packageManager: pnpm' } }],
      },
      {
        id: 'assistant-final', role: 'assistant', runId: 'run-1', stage: 'finalize',
        timestamp: '2026-07-11T01:00:04.000Z',
        content: [{ type: 'text', text: 'The file uses pnpm.' }],
      },
    ]

    const history = buildHistoryMessages(messages, new Map([['run-1', executionLog()]]))

    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user', text: 'Read the project file' })
    expect(history[1]).toMatchObject({
      role: 'assistant',
      text: 'The file uses pnpm.',
      durationMs: 4_000,
      activityCollapsed: true,
      activity: {
        status: 'done',
        instruction: 'Read the project file',
        durationMs: 4_000,
      },
    })
    expect(history[1]?.activity?.steps[0]).toMatchObject({
      stepId: 'step-1', status: 'done', toolCount: 1, output: 'packageManager: pnpm',
    })
    expect(history[1]?.activity?.tools[0]).toMatchObject({
      callId: 'call-1', name: 'read', stepId: 'step-1', ok: true,
      output: '{\n  "packageManager": "pnpm"\n}',
    })
  })

  it('recovers an interrupted run even when no final text message was persisted', () => {
    const messages: Message[] = [{
      id: 'assistant-tool', role: 'assistant', runId: 'run-1', stage: 'execute',
      timestamp: '2026-07-11T01:00:01.000Z',
      content: [{ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', input: {} }] }],
    }]
    const log = executionLog({ status: 'aborted', reply: '', error: 'Run was stopped by the user.' })

    const history = buildHistoryMessages(messages, new Map([['run-1', log]]))

    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      role: 'assistant',
      text: '',
      activityCollapsed: true,
      activity: { status: 'aborted', error: 'Run was stopped by the user.' },
    })
  })

  it('presents a persisted pause as paused rather than failed or user-stopped', () => {
    const messages: Message[] = [{
      id: 'assistant-tool', role: 'assistant', runId: 'run-1', stage: 'execute',
      timestamp: '2026-07-11T01:00:01.000Z',
      content: [{ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', input: {} }] }],
    }]
    const log = executionLog({
      status: 'aborted',
      reply: '',
      error: 'run paused at a safe boundary',
      runtimeControl: {
        version: 1,
        state: 'paused',
        reason: 'user requested pause',
        eventIds: ['pause-event-1'],
        changedAt: '2026-07-11T01:00:03.000Z',
      },
    })

    const history = buildHistoryMessages(messages, new Map([['run-1', log]]))

    expect(history[0]).toMatchObject({
      activity: { status: 'paused', error: '任务已暂停，现场已保存。' },
    })
  })

  it('does not expose a durable final-reply proposal as historical assistant text', () => {
    const messages: Message[] = [{
      id: 'assistant-proposal', role: 'assistant', runId: 'run-1', stage: 'finalize',
      timestamp: '2026-07-11T01:00:04.000Z',
      content: [{ type: 'text', text: 'unconfirmed model proposal' }],
      finalReplySettlement: {
        version: 1,
        settlementId: 'settlement-1',
        reply: 'unconfirmed model proposal',
        replyFingerprint: 'fingerprint-1',
        modelRequestId: 'request-1',
        status: 'proposed',
      },
    }]
    const history = buildHistoryMessages(messages, new Map([[
      'run-1', executionLog({ status: 'error', reply: 'unconfirmed model proposal' }),
    ]]))

    expect(history).toHaveLength(1)
    expect(history[0]?.text).toBe('')
    expect(JSON.stringify(history)).not.toContain('unconfirmed model proposal')
  })

  it('hides an unsettled proposal even when no execution log exists', () => {
    const messages: Message[] = [{
      id: 'assistant-proposal-no-log', role: 'assistant', runId: 'run-no-log', stage: 'finalize',
      timestamp: '2026-07-11T01:00:04.000Z',
      content: [{ type: 'text', text: 'proposal without a log' }],
      finalReplySettlement: {
        version: 1,
        settlementId: 'settlement-no-log',
        reply: 'proposal without a log',
        replyFingerprint: 'fingerprint-no-log',
        modelRequestId: 'request-no-log',
        status: 'proposed',
      },
    }]

    expect(buildHistoryMessages(messages, new Map())).toEqual([])
  })

  it('restores a proposed transcript message only when its execution log is settled', () => {
    const settlement = {
      version: 1 as const,
      settlementId: 'settlement-1',
      reply: 'durable settled reply',
      replyFingerprint: 'fingerprint-1',
      modelRequestId: 'request-1',
      status: 'settled' as const,
    }
    const messages: Message[] = [{
      id: 'assistant-proposal', role: 'assistant', runId: 'run-1', stage: 'finalize',
      timestamp: '2026-07-11T01:00:04.000Z',
      content: [{ type: 'text', text: 'transcript proposal' }],
      finalReplySettlement: { ...settlement, status: 'proposed' },
    }]
    const history = buildHistoryMessages(messages, new Map([[
      'run-1', executionLog({
        reply: 'stale execution-log reply',
        finalReplySettlement: settlement,
      }),
    ]]))

    expect(history).toHaveLength(1)
    expect(history[0]?.text).toBe('durable settled reply')
    expect(JSON.stringify(history)).not.toContain('transcript proposal')
    expect(JSON.stringify(history)).not.toContain('stale execution-log reply')
  })

  it('hides a transcript settlement that does not match the execution log', () => {
    const messages: Message[] = [{
      id: 'assistant-mismatched', role: 'assistant', runId: 'run-1', stage: 'finalize',
      timestamp: '2026-07-11T01:00:04.000Z',
      content: [{ type: 'text', text: 'mismatched settled text' }],
      finalReplySettlement: {
        version: 1,
        settlementId: 'settlement-other',
        reply: 'mismatched settled text',
        replyFingerprint: 'fingerprint-other',
        modelRequestId: 'request-other',
        status: 'settled',
      },
    }]
    const history = buildHistoryMessages(messages, new Map([[
      'run-1', executionLog({
        finalReplySettlement: {
          version: 1,
          settlementId: 'settlement-1',
          reply: 'durable settled text',
          replyFingerprint: 'fingerprint-1',
          modelRequestId: 'request-1',
          status: 'settled',
        },
      }),
    ]]))

    expect(history).toHaveLength(1)
    expect(history[0]?.text).toBe('')
    expect(JSON.stringify(history)).not.toContain('mismatched settled text')
  })

  it('survives the execution-log JSON round trip used after an app restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-history-activity-'))
    tempDirs.push(dir)
    const store = new ExecutionLogStore({ rootDir: dir })
    const source = executionLog()
    await store.write({
      ...source,
      messages: [{
        id: 'assistant-tool', role: 'assistant', runId: source.runId, stage: 'execute',
        timestamp: '2026-07-11T01:00:01.000Z',
        content: [{ type: 'tool_calls', calls: [source.toolCalls[0]!.call] }],
      }, {
        id: 'tool-1', role: 'tool', runId: source.runId, stage: 'execute',
        timestamp: '2026-07-11T01:00:02.000Z',
        content: [{ type: 'tool_result', result: source.toolCalls[0]!.result }],
      }],
    })
    const reloaded = await store.read(source.runId)
    expect(reloaded).not.toBeNull()
    const sessionMessages: Message[] = [{
      id: 'assistant-final', role: 'assistant', runId: source.runId, stage: 'finalize',
      timestamp: source.endedAt, content: [{ type: 'text', text: source.reply }],
    }]

    const history = buildHistoryMessages(sessionMessages, new Map([[source.runId, reloaded!]]))

    expect(history[0]?.activity?.steps[0]).toMatchObject({
      stepId: 'step-1', status: 'done', output: 'packageManager: pnpm',
    })
    expect(history[0]?.activity?.tools[0]).toMatchObject({
      callId: 'call-1', name: 'read', stepId: 'step-1', ok: true,
    })
  })

  it('recovers planned pending steps and verification evidence from the task contract', () => {
    const log = executionLog({
      taskBook: {
        assessment: {
          userNeed: 'inspect and verify', complexity: 'standard', goal: 'inspect and verify',
          successCriteria: ['verified'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
        },
        goal: 'inspect and verify', complexity: 'standard', successCriteria: ['verified'],
        steps: [
          { id: 'step-1', title: 'Inspect', description: 'inspect files' },
          { id: 'step-2', title: 'Report', description: 'report results' },
        ],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
      },
      taskExecution: {
        goal: 'inspect and verify', complexity: 'standard', status: 'partial',
        startedAt: '2026-07-11T01:00:00.000Z',
        steps: [{
          stepId: 'step-1', title: 'Inspect', description: 'inspect files', status: 'done',
          startedAt: '2026-07-11T01:00:00.100Z', endedAt: '2026-07-11T01:00:01.000Z',
          toolCallIds: [], toolResults: [],
        }],
      },
      verificationHistory: [{
        attempt: 1, verdict: 'needs_replan', reason: 'report is missing', feedback: 'complete step-2',
        failedStepIds: ['step-2'], verifiedAt: '2026-07-11T01:00:02.000Z', source: 'model',
      }],
    })

    const history = buildHistoryMessages([{
      id: 'assistant-final', role: 'assistant', runId: 'run-1', stage: 'finalize',
      timestamp: log.endedAt, content: [{ type: 'text', text: log.reply }],
    }], new Map([['run-1', log]]))

    expect(history[0]?.activity?.steps).toEqual([
      expect.objectContaining({ stepId: 'step-1', status: 'done' }),
      expect.objectContaining({ stepId: 'step-2', status: 'pending' }),
    ])
    expect(history[0]?.activity?.verificationHistory?.[0]).toMatchObject({
      verdict: 'needs_replan', failedStepIds: ['step-2'],
    })
  })
})
