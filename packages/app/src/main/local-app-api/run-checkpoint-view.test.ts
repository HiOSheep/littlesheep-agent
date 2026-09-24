import { describe, expect, it } from 'vitest'
import type { RunCheckpointInspection, RunCheckpointStoreDiagnostics } from '@littlesheep/runner'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import {
  pendingCheckpointHeads,
  toCheckpointDiagnostics,
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
      status: 'completed',
      decidedAt: '2026-07-29T10:02:00.000Z',
      updatedAt: '2026-07-29T10:02:00.000Z',
      reason: 'completed',
      resultStatus: 'ok',
      history: [{ status: 'completed', at: '2026-07-29T10:02:00.000Z', reason: 'completed', resultStatus: 'ok' }],
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
    source.checkpoint.currentStepId = 'step-a'
    source.checkpoint.activeStepIds = ['step-a', 'step-b']
    source.checkpoint.taskExecution = {
      goal: 'parallel work',
      complexity: 'standard',
      status: 'running',
      startedAt: '2026-07-29T09:59:00.000Z',
      steps: ['step-a', 'step-b'].map((stepId) => ({
        stepId,
        title: stepId,
        description: `run ${stepId}`,
        status: 'in_progress',
        executionMode: 'parallel',
        startedAt: '2026-07-29T09:59:00.000Z',
        toolCallIds: [],
        toolResults: [],
      })),
    }

    const summary = toCheckpointSummary(source)
    const detail = toCheckpointDetail(source)

    expect(summary.reason.length).toBeLessThanOrEqual(2_048)
    expect(summary).not.toHaveProperty('resumeState')
    expect(summary.activeStepIds).toEqual(['step-a', 'step-b'])
    expect(summary.progress.activeStepTitles).toEqual(['step-a', 'step-b'])
    expect(detail.pendingEventCount).toBe(2)
    expect(detail).not.toHaveProperty('context')
  })

  it('counts an unreadable record once instead of naming it as two problems', () => {
    const findings = (count: number, kind: 'corrupt' | 'temporary') => Array.from({ length: count }, (_, index) => ({
      kind,
      file: `checkpoint-${index}.json`,
      message: 'fixture',
      recordedAt: '2026-07-29T10:00:00.000Z',
    }))
    const diagnostics = (
      invalidFiles: number,
      warningFindings: RunCheckpointStoreDiagnostics['warningFindings'],
      all: RunCheckpointStoreDiagnostics['diagnostics'],
    ): RunCheckpointStoreDiagnostics => ({
      rootDir: 'C:\\data\\run-checkpoints',
      scannedFiles: 3,
      readFiles: 3,
      validFiles: 2,
      invalidFiles,
      warningFindings,
      diagnostics: all,
    })

    // One broken file: the corrupt finding belongs to the record the store already
    // counted, so it must not be reported a second time as an incomplete record.
    expect(toCheckpointDiagnostics(diagnostics(1, [], findings(1, 'corrupt'))))
      .toEqual({ invalidFiles: 1, warningCount: 0 })
    // A stale temporary file is a finding of its own and is counted as one.
    expect(toCheckpointDiagnostics(diagnostics(0, findings(1, 'temporary'), findings(1, 'temporary'))))
      .toEqual({ invalidFiles: 0, warningCount: 1 })
    expect(toCheckpointDiagnostics(diagnostics(2, [], findings(3, 'corrupt'))))
      .toEqual({ invalidFiles: 2, warningCount: 0 })
  })
})
