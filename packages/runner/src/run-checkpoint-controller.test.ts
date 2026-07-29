import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { RunCheckpointController } from './run-checkpoint-controller.js'
import { RunCheckpointDispositionStore } from './run-checkpoint-disposition-store.js'
import { RunCheckpointStore } from './run-checkpoint-store.js'

function checkpoint(id: string, sideEffects: RunCheckpoint['sideEffects'] = []): RunCheckpoint {
  return {
    version: 1,
    id,
    runId: `source-${id}`,
    sessionId: asSessionId(`session-${id}`),
    status: 'recoverable',
    currentStage: 'execute',
    taskBookRevision: 1,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects,
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
      origin: 'test',
      permissionPolicyId: 'restricted',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: ['read'],
      attachmentCount: 0,
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 0,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: [],
    },
    createdAt: '2026-07-18T10:00:00.000Z',
    reason: 'interrupted',
  }
}

async function stores() {
  const dir = await mkdtemp(join(tmpdir(), 'ls-checkpoint-controller-'))
  const checkpointStore = new RunCheckpointStore({ rootDir: join(dir, 'checkpoints') })
  const dispositionStore = new RunCheckpointDispositionStore({ rootDir: join(dir, 'dispositions') })
  await checkpointStore.initialize()
  await dispositionStore.initialize()
  return { dir, checkpointStore, dispositionStore, controller: new RunCheckpointController({ checkpointStore, dispositionStore }) }
}

describe('RunCheckpointController', () => {
  it('keeps inspect side-effect free and reports inspect-only legacy checkpoints', async () => {
    const state = await stores()
    try {
      const legacy = checkpoint('legacy')
      delete legacy.resumeState
      await state.checkpointStore.write(legacy)
      const inspection = await state.controller.inspect('legacy', 'test/model')
      expect(inspection).toMatchObject({ resumable: false, disposition: null })
      expect(inspection?.reasons).toContain('checkpoint has no resumable runtime state')
      expect(await state.dispositionStore.read('legacy')).toBeNull()
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('blocks uncertain side effects and allows a verified checkpoint to be claimed once', async () => {
    const state = await stores()
    try {
      await state.checkpointStore.write(checkpoint('uncertain', [{
        idempotencyKey: 'tool:exec:1',
        toolName: 'exec',
        status: 'unknown',
        effectKind: 'external',
      }]))
      const blocked = await state.controller.claimResume('uncertain', 'approve', 'resume-uncertain', 'test/model')
      expect(blocked.kind).toBe('blocked')
      if (blocked.kind === 'blocked') expect(blocked.inspection.reasons[0]).toContain('without verified completion')

      await state.checkpointStore.write(checkpoint('safe', [{
        idempotencyKey: 'tool:write:1',
        toolName: 'write',
        status: 'succeeded',
        effectKind: 'local_mutation',
        evidenceRef: 'tool-call-1',
      }]))
      const claimed = await state.controller.claimResume('safe', 'approve', 'resume-safe', 'test/model')
      expect(claimed).toMatchObject({ kind: 'claimed', disposition: { status: 'resuming' } })
      const second = await state.controller.claimResume('safe', 'again', 'resume-safe-2', 'test/model')
      expect(second.kind).toBe('conflict')
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('treats an interrupted resume as resumable and lets a new run reclaim it', async () => {
    const state = await stores()
    try {
      await state.checkpointStore.write(checkpoint('restart-safe'))
      expect(await state.controller.claimResume('restart-safe', 'first', 'resume-before-restart', 'test/model'))
        .toMatchObject({ kind: 'claimed' })
      expect(await state.controller.interruptResume(
        'restart-safe',
        'resume-before-restart',
        'application restarted',
      )).toMatchObject({ kind: 'written', disposition: { status: 'interrupted' } })

      const inspection = await state.controller.inspect('restart-safe', 'test/model')
      expect(inspection).toMatchObject({ resumable: true, disposition: { status: 'interrupted' } })
      expect(await state.controller.claimResume('restart-safe', 'continue', 'resume-after-restart', 'test/model'))
        .toMatchObject({
          kind: 'claimed',
          disposition: { status: 'resuming', resumeRunId: 'resume-after-restart' },
        })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })
})
