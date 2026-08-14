import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RunCheckpointDispositionStore,
} from './run-checkpoint-disposition-store.js'

function clock(start = '2026-07-18T10:00:00.000Z') {
  let value = Date.parse(start)
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => { value += milliseconds },
  }
}

async function tempStore(maxRecords?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'ls-run-dispositions-'))
  const time = clock()
  const store = new RunCheckpointDispositionStore({ rootDir: dir, maxRecords, now: time.now })
  await store.initialize()
  return { dir, store, time }
}

describe('RunCheckpointDispositionStore', () => {
  it('seals a source-run checkpoint as completed and keeps the decision idempotent', async () => {
    const { dir, store } = await tempStore()
    try {
      expect(await store.completeSourceRun('checkpoint-complete', 'source run completed'))
        .toMatchObject({
          kind: 'written',
          disposition: { status: 'completed', resultStatus: 'ok' },
        })
      expect(await store.completeSourceRun('checkpoint-complete', 'duplicate completion'))
        .toMatchObject({ kind: 'duplicate', disposition: { status: 'completed' } })
      expect(await store.claimResume('checkpoint-complete', 'should not resume', 'resume-after-complete'))
        .toMatchObject({ kind: 'conflict', disposition: { status: 'completed' } })
      expect(await store.abandon('checkpoint-complete', 'should not abandon'))
        .toMatchObject({ kind: 'conflict', disposition: { status: 'completed' } })

      await store.claimResume('checkpoint-interrupted', 'stale resume', 'resume-before-restart')
      await store.interruptResume('checkpoint-interrupted', 'resume-before-restart', 'application restarted')
      expect(await store.completeSourceRun('checkpoint-interrupted', 'successful source log is authoritative'))
        .toMatchObject({
          kind: 'written',
          disposition: {
            status: 'completed',
            resultStatus: 'ok',
            history: [
              { status: 'resuming' },
              { status: 'interrupted' },
              { status: 'completed', resultStatus: 'ok' },
            ],
          },
        })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('atomically claims one resume decision and rejects conflicting claims', async () => {
    const { dir, store } = await tempStore()
    try {
      const first = await store.claimResume('checkpoint-1', 'user approved', 'resume-1')
      expect(first.kind).toBe('written')
      expect(await store.read('checkpoint-1')).toMatchObject({ status: 'resuming', resumeRunId: 'resume-1' })

      const duplicate = await store.claimResume('checkpoint-1', 'again', 'resume-2')
      expect(duplicate).toMatchObject({ kind: 'duplicate', disposition: { resumeRunId: 'resume-1' } })

      const completed = await store.completeResume('checkpoint-1', 'resume-1', 'ok', 'continued')
      expect(completed).toMatchObject({ kind: 'written', disposition: { status: 'resumed', resultStatus: 'ok' } })
      expect((await store.read('checkpoint-1'))?.history).toHaveLength(2)

      const conflict = await store.claimResume('checkpoint-1', 'replay', 'resume-3')
      expect(conflict).toMatchObject({ kind: 'conflict', disposition: { status: 'resumed' } })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists durable dispositions by status and ignores corrupt records', async () => {
    const { dir, store, time } = await tempStore()
    try {
      await store.claimResume('list-resuming', 'active continuation', 'list-resume-run')
      time.advance(1_000)
      await store.claimResume('list-completed', 'finished continuation', 'list-completed-run')
      await store.completeResume('list-completed', 'list-completed-run', 'ok', 'finished')
      await writeFile(join(dir, 'corrupt.json'), '{not-json', 'utf8')

      await expect(store.list({ statuses: ['resuming'] })).resolves.toEqual([
        expect.objectContaining({ checkpointId: 'list-resuming', status: 'resuming' }),
      ])
      await expect(store.list({ statuses: ['resumed'], limit: 1 })).resolves.toEqual([
        expect.objectContaining({ checkpointId: 'list-completed', status: 'resumed' }),
      ])
      await expect(store.list()).resolves.toHaveLength(2)
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters durable claims by resume run and request key before applying the result limit', async () => {
    const { dir, store } = await tempStore()
    try {
      await store.claimResume('matching-claim', 'matching turn', 'shared-resume-run', {
        requestId: 'matching-request',
        answerMessageId: 'matching-answer',
        requestKey: 'matching-key',
      })
      await store.claimResume('same-run-other-key', 'different turn', 'shared-resume-run', {
        requestId: 'other-request',
        answerMessageId: 'other-answer',
        requestKey: 'other-key',
      })
      await store.claimResume('newest-unrelated', 'unrelated turn', 'unrelated-run', {
        requestId: 'unrelated-request',
        answerMessageId: 'unrelated-answer',
        requestKey: 'matching-key',
      })

      await expect(store.list({
        resumeRunId: 'shared-resume-run',
        requestKey: 'matching-key',
        limit: 1,
      })).resolves.toEqual([
        expect.objectContaining({ checkpointId: 'matching-claim' }),
      ])
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('requires the owning resume lease to complete and supports explicit abandonment', async () => {
    const { dir, store } = await tempStore()
    try {
      await store.claimResume('checkpoint-2', 'approved', 'resume-2')
      expect(await store.completeResume('checkpoint-2', 'other-run', 'ok', 'wrong owner'))
        .toMatchObject({ kind: 'conflict', disposition: { status: 'resuming' } })
      expect(await store.abandon('checkpoint-2', 'user abandoned'))
        .toMatchObject({ kind: 'written', disposition: { status: 'abandoned' } })
      expect(await store.abandon('checkpoint-2', 'again')).toMatchObject({ kind: 'duplicate' })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases an interrupted resume lease and allows a new run to claim it', async () => {
    const { dir, store } = await tempStore()
    try {
      await store.claimResume('checkpoint-interrupted', 'first attempt', 'resume-1')
      expect(await store.interruptResume('checkpoint-interrupted', 'other-run', 'wrong owner'))
        .toMatchObject({ kind: 'conflict', disposition: { status: 'resuming' } })

      const interrupted = await store.interruptResume(
        'checkpoint-interrupted',
        'resume-1',
        'application restarted',
      )
      expect(interrupted).toMatchObject({
        kind: 'written',
        disposition: { status: 'interrupted', resumeRunId: 'resume-1' },
      })
      expect(await store.interruptResume('checkpoint-interrupted', 'resume-1', 'again'))
        .toMatchObject({ kind: 'duplicate', disposition: { status: 'interrupted' } })

      const reclaimed = await store.claimResume('checkpoint-interrupted', 'retry', 'resume-2')
      expect(reclaimed).toMatchObject({
        kind: 'written',
        disposition: { status: 'resuming', resumeRunId: 'resume-2' },
      })
      expect((await store.read('checkpoint-interrupted'))?.history.map((entry) => entry.status))
        .toEqual(['resuming', 'interrupted', 'resuming'])
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reconciles an interrupted lease only when a completion receipt belongs to the same run', async () => {
    const { dir, store } = await tempStore()
    try {
      await store.claimResume('checkpoint-receipt', 'first attempt', 'resume-receipt')
      await store.interruptResume('checkpoint-receipt', 'resume-receipt', 'process stopped')

      await expect(store.reconcileCompletedResume(
        'checkpoint-receipt',
        'other-run',
        'ok',
        'wrong completion receipt',
      )).resolves.toMatchObject({ kind: 'conflict', disposition: { status: 'interrupted' } })
      await expect(store.reconcileCompletedResume(
        'checkpoint-receipt',
        'resume-receipt',
        'ok',
        'session contains the final reply',
        'effect-checkpoint',
      )).resolves.toMatchObject({
        kind: 'written',
        disposition: {
          status: 'resumed',
          resultStatus: 'ok',
          resumeRunId: 'resume-receipt',
          nextCheckpointId: 'effect-checkpoint',
        },
      })
      await expect(store.reconcileCompletedResume(
        'checkpoint-receipt',
        'resume-receipt',
        'ok',
        'duplicate receipt',
      )).resolves.toMatchObject({ kind: 'duplicate', disposition: { status: 'resumed' } })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent claims and keeps disposition history bounded', async () => {
    const { dir, store, time } = await tempStore(2)
    try {
      const outcomes = await Promise.all([
        store.claimResume('same', 'first', 'r1'),
        store.claimResume('same', 'second', 'r2'),
      ])
      expect(outcomes.filter((item) => item.kind === 'written')).toHaveLength(1)
      expect(outcomes.filter((item) => item.kind === 'duplicate')).toHaveLength(1)

      await store.abandon('other-1', 'cleanup')
      time.advance(1)
      await store.abandon('other-2', 'cleanup')
      expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(2)
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates the same answer claim and rejects a different conversation turn', async () => {
    const { dir, store } = await tempStore()
    try {
      const identity = {
        requestId: 'request-1',
        answerMessageId: 'answer-1',
        requestKey: 'turn-1',
        continuationDisposition: 'retry' as const,
      }
      await expect(store.claimResume('answer-checkpoint', 'first', 'resume-1', identity))
        .resolves.toMatchObject({ kind: 'written', disposition: identity })
      await expect(store.claimResume('answer-checkpoint', 'network retry', 'resume-2', identity))
        .resolves.toMatchObject({ kind: 'duplicate', disposition: { resumeRunId: 'resume-1', ...identity } })
      await expect(store.claimResume('answer-checkpoint', 'other window', 'resume-3', {
        requestId: 'request-1',
        answerMessageId: 'answer-2',
        requestKey: 'turn-2',
      })).resolves.toMatchObject({
        kind: 'conflict',
        disposition: { resumeRunId: 'resume-1' },
      })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('only lets the original answer identity reclaim an interrupted lease', async () => {
    const { dir, store } = await tempStore()
    try {
      const identity = {
        requestId: 'request-1',
        answerMessageId: 'answer-1',
        requestKey: 'turn-1',
        continuationDisposition: 'revise_goal' as const,
      }
      await store.claimResume('interrupted-answer', 'first', 'resume-1', identity)
      await store.interruptResume('interrupted-answer', 'resume-1', 'process stopped')

      await expect(store.claimResume('interrupted-answer', 'different turn', 'resume-2', {
        requestId: 'request-1',
        answerMessageId: 'answer-2',
        requestKey: 'turn-2',
        continuationDisposition: 'retry',
      })).resolves.toMatchObject({ kind: 'conflict', disposition: { status: 'interrupted' } })
      await expect(store.claimResume('interrupted-answer', 'same turn retry', 'resume-3', identity))
        .resolves.toMatchObject({
          kind: 'written',
          disposition: { status: 'resuming', resumeRunId: 'resume-3', ...identity },
        })
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses a cross-instance CAS boundary for competing defer and resume decisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-run-disposition-cas-'))
    const first = new RunCheckpointDispositionStore({ rootDir: dir })
    const second = new RunCheckpointDispositionStore({ rootDir: dir })
    await Promise.all([first.initialize(), second.initialize()])
    try {
      const outcomes = await Promise.all([
        first.defer('cas-checkpoint', 'user selected a new task', {
          requestId: 'request-cas',
          answerMessageId: 'answer-new-task',
          requestKey: 'turn-new-task',
          continuationDisposition: 'new_task',
        }),
        second.claimResume('cas-checkpoint', 'user answered the old task', 'resume-cas', {
          requestId: 'request-cas',
          answerMessageId: 'answer-old-task',
          requestKey: 'turn-old-task',
          continuationDisposition: 'answer',
        }),
      ])

      expect(outcomes.filter((outcome) => outcome.kind === 'written')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.kind === 'conflict')).toHaveLength(1)
      expect(await first.read('cas-checkpoint')).toEqual(await second.read('cas-checkpoint'))
    } finally {
      first.dispose()
      second.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists deferred state across restart and allows a later explicit claim', async () => {
    const { dir, store } = await tempStore()
    try {
      await expect(store.defer('restart-deferred', 'new task selected', {
        requestId: 'request-deferred',
        answerMessageId: 'answer-deferred',
        requestKey: 'turn-deferred',
        continuationDisposition: 'new_task',
      })).resolves.toMatchObject({
        kind: 'written',
        disposition: { status: 'deferred', continuationDisposition: 'new_task' },
      })
      store.dispose()

      const restarted = new RunCheckpointDispositionStore({ rootDir: dir })
      await restarted.initialize()
      try {
        await expect(restarted.read('restart-deferred')).resolves.toMatchObject({
          status: 'deferred',
          requestKey: 'turn-deferred',
          continuationDisposition: 'new_task',
        })
        await expect(restarted.claimResume(
          'restart-deferred',
          'user explicitly returned to the old task',
          'resume-after-restart',
          undefined,
          { allowDeferred: true },
        )).resolves.toMatchObject({
          kind: 'written',
          disposition: { status: 'resuming', resumeRunId: 'resume-after-restart' },
        })
      } finally {
        restarted.dispose()
      }
    } finally {
      store.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
