import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { RunCheckpointController } from './run-checkpoint-controller.js'
import { createRunCheckpointControl } from './run-checkpoint-control.js'
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
  const dispositionStore = new RunCheckpointDispositionStore({ rootDir: join(dir, 'dispositions') })
  await dispositionStore.initialize()
  const checkpointStore = new RunCheckpointStore({
    rootDir: join(dir, 'checkpoints'),
    protectedCheckpointIds: async () => new Set((await dispositionStore.list({
      statuses: ['resuming', 'interrupted', 'deferred'],
    })).flatMap((disposition) => [
      disposition.checkpointId,
      ...(disposition.nextCheckpointId ? [disposition.nextCheckpointId] : []),
    ])),
    protectedRunIds: async () => new Set((await dispositionStore.list({
      statuses: ['resuming'],
    })).flatMap((disposition) => disposition.resumeRunId ? [disposition.resumeRunId] : [])),
  })
  await checkpointStore.initialize()
  return { dir, checkpointStore, dispositionStore, controller: new RunCheckpointController({ checkpointStore, dispositionStore }) }
}

describe('RunCheckpointController', () => {
  it('keeps waiting-user and paused checkpoints open when a source run returns ok', async () => {
    const state = await stores()
    try {
      for (const status of ['waiting_user', 'paused'] as const) {
        const source = checkpoint(`open-${status}`)
        source.status = status
        await state.checkpointStore.write(source)

        await expect(state.controller.completeSourceRun(
          source.id,
          String(source.runId),
          'source API result was ok',
        )).resolves.toBeNull()
        expect(await state.dispositionStore.read(source.id)).toBeNull()
      }

      const readExecutionLog = vi.fn(async (runId: string) => ({
        runId,
        status: 'ok',
        runCheckpointId: runId.replace('source-open-', 'open-'),
      }))
      const control = createRunCheckpointControl(
        state.controller,
        state.checkpointStore,
        { read: readExecutionLog } as never,
        'test/model',
      )!

      expect(await control.reconcileCompletedRuns('startup reconciliation')).toBe(0)
      await expect(state.controller.resolveWaitingUserHead(
        asSessionId('session-open-waiting_user'),
        'test/model',
      )).resolves.toMatchObject({
        kind: 'eligible',
        checkpointId: 'open-waiting_user',
      })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('reconciles a successful execution log into a completed checkpoint disposition', async () => {
    const state = await stores()
    try {
      await state.checkpointStore.write(checkpoint('completed-head'))
      await state.dispositionStore.claimResume('completed-head', 'stale resume', 'stale-resume-run')
      await state.dispositionStore.interruptResume(
        'completed-head',
        'stale-resume-run',
        'application restarted',
      )
      const readExecutionLog = vi.fn(async (runId: string) => runId === 'source-completed-head' ? ({
        runId,
        status: 'ok',
        runCheckpointId: 'completed-head',
      }) : null)
      const control = createRunCheckpointControl(
        state.controller,
        state.checkpointStore,
        { read: readExecutionLog } as never,
        'test/model',
      )!

      expect(await control.reconcileCompletedRuns('startup reconciliation')).toBe(1)
      expect(await state.dispositionStore.read('completed-head')).toMatchObject({
        status: 'completed',
        resultStatus: 'ok',
      })
      expect((await state.controller.inspect('completed-head', 'test/model'))?.resumable).toBe(false)
      expect(await control.reconcileCompletedRuns('duplicate startup reconciliation')).toBe(0)
      expect(readExecutionLog).toHaveBeenCalledWith('source-completed-head')
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('reconciles a successful continuation log onto the original waiting head', async () => {
    const state = await stores()
    try {
      const source = checkpoint('resume-completed-source')
      source.status = 'waiting_user'
      await state.checkpointStore.write(source)
      await state.dispositionStore.claimResume(source.id, 'resume started', 'completed-resume-run')

      const continuation = checkpoint('resume-completed-next')
      continuation.runId = 'completed-resume-run'
      continuation.sessionId = source.sessionId
      continuation.createdAt = '2026-07-18T10:00:01.000Z'
      await state.checkpointStore.write(continuation)
      const readExecutionLog = vi.fn(async (runId: string) => runId === 'completed-resume-run' ? ({
        runId,
        status: 'ok',
        runCheckpointId: continuation.id,
      }) : null)
      const control = createRunCheckpointControl(
        state.controller,
        state.checkpointStore,
        { read: readExecutionLog } as never,
        'test/model',
      )!

      expect(await control.recoverInterruptedResumes('application restarted')).toBe(1)
      expect(await control.reconcileCompletedRuns('startup completion receipt')).toBe(1)
      expect(await state.dispositionStore.read(source.id)).toMatchObject({
        status: 'resumed',
        resultStatus: 'ok',
        resumeRunId: 'completed-resume-run',
        nextCheckpointId: continuation.id,
      })
      expect(await state.dispositionStore.read(continuation.id)).toBeNull()
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

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

  it('recovers a stale resume beyond the UI inspection window and links its latest runtime checkpoint', async () => {
    const state = await stores()
    try {
      const source = checkpoint('startup-source')
      source.status = 'waiting_user'
      source.createdAt = '2026-07-18T00:00:00.000Z'
      await state.checkpointStore.write(source)
      await state.dispositionStore.claimResume(
        source.id,
        'resume before process loss',
        'startup-resume-run',
      )

      const started = checkpoint('startup-effect-started', [{
        idempotencyKey: 'tool:write:startup',
        toolName: 'write',
        status: 'in_progress',
        effectKind: 'local_mutation',
      }])
      started.runId = 'startup-resume-run'
      started.sessionId = source.sessionId
      started.createdAt = '2026-07-18T00:00:01.000Z'
      await state.checkpointStore.write(started)

      const finished = checkpoint('startup-effect-finished', [{
        idempotencyKey: 'tool:write:startup',
        toolName: 'write',
        status: 'succeeded',
        effectKind: 'local_mutation',
        evidenceRef: 'tool:startup-write',
      }])
      finished.runId = 'startup-resume-run'
      finished.sessionId = source.sessionId
      finished.createdAt = '2026-07-18T00:00:02.000Z'
      await state.checkpointStore.write(finished)

      for (let index = 0; index < 130; index += 1) {
        const filler = checkpoint(`newer-${index}`)
        filler.createdAt = new Date(Date.UTC(2026, 6, 19, 0, 0, index)).toISOString()
        await state.checkpointStore.write(filler)
      }

      const control = createRunCheckpointControl(
        state.controller,
        state.checkpointStore,
        undefined,
        'test/model',
      )!
      expect((await control.list(128)).some((item) => item.checkpoint.id === source.id)).toBe(false)
      expect(await control.recoverInterruptedResumes('application restarted')).toBe(1)
      expect(await state.dispositionStore.read(source.id)).toMatchObject({
        status: 'interrupted',
        resumeRunId: 'startup-resume-run',
        nextCheckpointId: finished.id,
      })
      await expect(control.resolveWaitingUserHead(source.sessionId)).resolves.toMatchObject({
        kind: 'eligible',
        checkpointId: source.id,
      })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('resolves a resume claim from disposition identity instead of checkpoint list position', async () => {
    const state = await stores()
    try {
      await state.dispositionStore.claimResume('claim-source', 'bound answer', 'claim-run', {
        requestId: 'claim-request',
        answerMessageId: 'claim-answer',
        requestKey: 'claim-key',
      })
      await state.dispositionStore.claimResume('other-source', 'other answer', 'claim-run', {
        requestId: 'other-request',
        answerMessageId: 'other-answer',
        requestKey: 'other-key',
      })

      await expect(state.controller.resolveResumeClaim('claim-run', 'claim-key')).resolves.toEqual({
        kind: 'found',
        disposition: expect.objectContaining({ checkpointId: 'claim-source' }),
      })
      await expect(state.controller.resolveResumeClaim('missing-run', 'missing-key'))
        .resolves.toEqual({ kind: 'none' })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('resolves the only pending waiting-user head for a session', async () => {
    const state = await stores()
    try {
      const waiting = checkpoint('waiting-head')
      waiting.status = 'waiting_user'
      waiting.sessionId = asSessionId('shared-session')
      waiting.resumeState!.continuation = {
        version: 1,
        requestId: 'request-waiting-head',
        sourceStage: 'recover',
      }
      await state.checkpointStore.write(waiting)

      const unrelated = checkpoint('unrelated-head')
      unrelated.status = 'waiting_user'
      unrelated.sessionId = asSessionId('other-session')
      await state.checkpointStore.write(unrelated)

      await expect(state.controller.resolveWaitingUserHead(
        asSessionId('shared-session'),
        'test/model',
      )).resolves.toMatchObject({
        kind: 'eligible',
        checkpointId: 'waiting-head',
        requestId: 'request-waiting-head',
      })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('fails closed when a session has multiple pending waiting-user heads', async () => {
    const state = await stores()
    try {
      const first = checkpoint('waiting-first')
      first.status = 'waiting_user'
      first.sessionId = asSessionId('conflicted-session')
      const second = checkpoint('waiting-second')
      second.status = 'waiting_user'
      second.sessionId = asSessionId('conflicted-session')
      await state.checkpointStore.write(first)
      await state.checkpointStore.write(second)

      await expect(state.controller.resolveWaitingUserHead(
        asSessionId('conflicted-session'),
        'test/model',
      )).resolves.toEqual({
        kind: 'conflict',
        checkpointIds: expect.arrayContaining(['waiting-first', 'waiting-second']),
      })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })

  it('excludes deferred tasks from automatic binding but keeps explicit recovery available', async () => {
    const state = await stores()
    try {
      const waiting = checkpoint('deferred-head')
      waiting.status = 'waiting_user'
      waiting.sessionId = asSessionId('deferred-session')
      waiting.resumeState!.continuation = {
        version: 1,
        requestId: 'request-deferred-head',
        sourceStage: 'recover',
      }
      await state.checkpointStore.write(waiting)
      await expect(state.controller.defer(waiting.id, 'user started another task'))
        .resolves.toMatchObject({ kind: 'written', disposition: { status: 'deferred' } })

      await expect(state.controller.resolveWaitingUserHead(
        waiting.sessionId,
        'test/model',
      )).resolves.toEqual({ kind: 'none' })
      await expect(state.controller.claimResume(
        waiting.id,
        'explicitly return to the deferred task',
        'resume-deferred',
        'test/model',
        undefined,
        { allowDeferred: true },
      )).resolves.toMatchObject({ kind: 'claimed', disposition: { status: 'resuming' } })
    } finally {
      state.checkpointStore.dispose()
      state.dispositionStore.dispose()
      await rm(state.dir, { recursive: true, force: true })
    }
  })
})
