import { describe, expect, it } from 'vitest'
import type { RunCheckpointInspection } from '@littlesheep/runner'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import {
  pendingCheckpointHeads,
  toCheckpointDetail,
  toCheckpointSummary,
} from './run-checkpoint-view.js'

function inspection(
  id: string,
  sourceRunId: string,
  disposition?: RunCheckpointInspection['disposition'],
): RunCheckpointInspection {
  const checkpoint: RunCheckpoint = {
    version: 1,
    id,
    runId: sourceRunId,
    sessionId: asSessionId(`session-${sourceRunId}`),
    status: 'recoverable',
    currentStage: 'execute',
    taskBookRevision: 1,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects: [],
    loopBudget: {
      attemptsUsed: 1,
      maxAttempts: 8,
      elapsedMs: 100,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
    resumeState: {
      version: 1,
      inboundMessageId: `inbound-${id}`,
      cwd: 'C:\\workspace',
      model: 'test/model',
      origin: 'app',
      permissionPolicyId: 'research',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: [],
      attachmentCount: 0,
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 0,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: [],
    },
    createdAt: '2026-07-29T10:00:00.000Z',
    reason: 'interrupted',
  }
  return { checkpoint, disposition: disposition ?? null, resumable: !disposition, reasons: [] }
}

describe('run checkpoint renderer view', () => {
  it('keeps only the newest head and never resurfaces an older snapshot after completion', () => {
    const completed = inspection('new-head', 'source-1', {
      version: 1,
      checkpointId: 'new-head',
      status: 'resumed',
      decidedAt: '2026-07-29T10:02:00.000Z',
      updatedAt: '2026-07-29T10:02:00.000Z',
      reason: 'completed',
      history: [{ status: 'resumed', at: '2026-07-29T10:02:00.000Z', reason: 'completed' }],
    })
    const old = inspection('old-head', 'source-1')
    const pending = inspection('other-head', 'source-2')

    expect(pendingCheckpointHeads([completed, old, pending]).map((item) => item.checkpoint.id))
      .toEqual(['other-head'])
  })

  it('exposes bounded summaries and progressive detail without the full resume state', () => {
    const source = inspection('bounded', 'source-bounded')
    source.checkpoint.reason = 'x'.repeat(4_000)
    source.checkpoint.pendingEventIds = ['event-1', 'event-2']

    const summary = toCheckpointSummary(source)
    const detail = toCheckpointDetail(source)

    expect(summary.reason.length).toBeLessThanOrEqual(2_048)
    expect(summary).not.toHaveProperty('resumeState')
    expect(detail.pendingEventCount).toBe(2)
    expect(detail).not.toHaveProperty('context')
  })
})
