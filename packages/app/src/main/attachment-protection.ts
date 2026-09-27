// Deferred attachment protection, owned in one place.
//
// The cache decides what it may **delete** from the checkpoint list plus its own directory. Running that
// pass used to happen inline in `setRunner`, which put two scans that grow with existing data — up to 128
// checkpoint files and the whole cache directory — between the runner existing and readiness being
// published. Nothing about accepting a message needs either scan, so it runs here, after readiness, on the
// same exclusive queue as every other cache operation: the only failure mode is keeping a file longer than
// necessary, never dropping one early.

import type { AgentRunner } from '@littlesheep/runner'
import type { ManagedAttachmentCache } from './attachment-cache.js'
import { recordBootstrapTiming } from './bootstrap-timing.js'

/** How many checkpoint files may protect an attachment from cleanup. */
const PROTECTED_CHECKPOINT_LIMIT = 128

export interface AttachmentProtectionHandle {
  /** Resolves when the pass has finished; `stop()` awaits it so shutdown cannot race the index write. */
  readonly settled: Promise<void>
}

export function deferAttachmentProtection(
  runner: AgentRunner,
  cache: ManagedAttachmentCache,
): AttachmentProtectionHandle {
  const settled = (async () => {
    const startedAt = process.hrtime.bigint()
    const protectedIds = new Set<string>()
    const inspections = typeof runner.runCheckpoints?.list === 'function'
      ? await runner.runCheckpoints.list(PROTECTED_CHECKPOINT_LIMIT)
      : []
    for (const inspection of inspections) {
      // A settled checkpoint no longer needs its attachments held.
      if (inspection.disposition?.status === 'resumed'
        || inspection.disposition?.status === 'completed'
        || inspection.disposition?.status === 'abandoned') continue
      for (const reference of inspection.checkpoint.resumeState?.attachments ?? []) {
        protectedIds.add(reference.cacheId)
      }
    }
    const listedAt = process.hrtime.bigint()
    await cache.initialize(protectedIds)
    // Opt-in numbers for a real data root: these two are what it spends here.
    recordBootstrapTiming('attachment-protection-checkpoints', undefined, {
      durationMs: Number(listedAt - startedAt) / 1e6,
    })
    recordBootstrapTiming('attachment-protection', undefined, {
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    })
  })().catch((error: unknown) => {
    // Keeping the files when protection cannot be established is the safe direction.
    console.error(`[attachments] protection pass failed: ${(error as Error).message}`)
  })
  return { settled }
}
