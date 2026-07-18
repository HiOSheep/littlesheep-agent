import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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
})
