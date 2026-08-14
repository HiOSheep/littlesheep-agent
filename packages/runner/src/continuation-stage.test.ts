import { describe, expect, it } from 'vitest'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { resolveSemanticResumeStage } from './continuation-stage.js'

function checkpoint(): RunCheckpoint {
  return {
    version: 1,
    id: 'stage-checkpoint',
    runId: 'stage-source-run',
    sessionId: asSessionId('stage-session'),
    status: 'waiting_user',
    currentStage: 'finalize',
    taskBookRevision: 0,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects: [],
    loopBudget: {
      attemptsUsed: 0,
      maxAttempts: 8,
      elapsedMs: 0,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
    createdAt: new Date().toISOString(),
    reason: 'waiting',
  }
}

describe('semantic checkpoint continuation stage', () => {
  it.each([
    ['classify', 'decide'],
    ['decide', 'decide'],
    ['execute', 'recover'],
    ['recover', 'recover'],
    ['verify', 'decide'],
  ] as const)('routes a %s clarification to %s instead of FINALIZE/REPLY', (source, expected) => {
    expect(resolveSemanticResumeStage(checkpoint(), source)).toBe(expected)
  })

  it('fails closed when a waiting checkpoint has no structured source stage', () => {
    expect(() => resolveSemanticResumeStage(checkpoint())).toThrow('no semantic clarification source')
  })

  it('uses failure and incomplete task evidence for a non-waiting FINALIZE checkpoint', () => {
    const failed = checkpoint()
    failed.status = 'recoverable'
    failed.resumeState = {
      version: 1,
      inboundMessageId: 'inbound',
      cwd: 'C:\\workspace',
      model: 'test/model',
      origin: 'test',
      permissionPolicyId: 'research',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: [],
      attachmentCount: 0,
      lastError: { stage: 'execute', message: 'permission denied' },
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 1,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: [],
    }
    expect(resolveSemanticResumeStage(failed)).toBe('recover')
  })
})
