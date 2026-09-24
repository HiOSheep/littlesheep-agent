// Startup contract of the durable Harness stores: they are independent scans, so
// they run together, and the first failure in declaration order is the one the
// Runner records and closes admission on.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDurableHarnessInfrastructure } from './durable-harness-infrastructure.js'

const STORE_MARKS = [
  'runner-infra-durable-events-ready',
  'runner-infra-durable-inbox-ready',
  'runner-infra-durable-run-leases-ready',
  'runner-infra-durable-effect-leases-ready',
]

const roots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-infrastructure-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable harness infrastructure startup', () => {
  it('initializes all four stores against an empty data root', async () => {
    const root = await createRoot()
    const log = vi.fn()
    const marks: Array<{ stage: string; durationMs: number | undefined }> = []

    const infrastructure = await buildDurableHarnessInfrastructure(root, log, (stage, durationMs) => {
      marks.push({ stage, durationMs })
    })

    expect(infrastructure.durableHarnessInitializationError).toBeUndefined()
    expect(infrastructure.durableEventStore.isInitialized).toBe(true)
    expect(infrastructure.durableInboxStore.isInitialized).toBe(true)
    // Concurrent work reports in completion order, so the assertion is on the set.
    expect(new Set(marks.map((mark) => mark.stage))).toEqual(new Set(STORE_MARKS))
    expect(marks.every((mark) => typeof mark.durationMs === 'number' && mark.durationMs >= 0)).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('records the first declared failure and still attempts the later stores', async () => {
    const root = await createRoot()
    // Two stores fail here: the event root is a file, and the lease directory
    // holds a file the store does not own. The event store is declared first.
    await writeFile(join(root, 'durable-events'), 'not a directory', 'utf8')
    await mkdir(join(root, 'durable-run-leases'), { recursive: true })
    await writeFile(join(root, 'durable-run-leases', 'not-a-lease.txt'), 'x', 'utf8')
    const log = vi.fn()
    const marks: string[] = []

    const infrastructure = await buildDurableHarnessInfrastructure(root, log, (stage) => marks.push(stage))

    expect(infrastructure.durableHarnessInitializationError?.message).toMatch(/EEXIST/)
    expect(infrastructure.durableEventStore.isInitialized).toBe(false)
    await expect(infrastructure.durableEventStore.initialize()).rejects.toThrow(/EEXIST/)
    // The documented difference from sequential startup: the stores after the
    // failure have already started, and the ones that are sound complete.
    expect(infrastructure.durableInboxStore.isInitialized).toBe(true)
    expect(marks).toHaveLength(STORE_MARKS.length)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('durable Harness stores unavailable'),
    )
  })
})
