// Read-only Memory v3 migration status for the management UI.

import type { MemoryV2ToV3MigrationManager, MemoryV3MigrationPreflight } from '@littlesheep/memory-tree'
import type { MemoryV3MigrationPreflightOverview } from '../shared/memory-control-contracts.js'

export async function inspectMemoryV3Migration(
  manager: MemoryV2ToV3MigrationManager,
): Promise<MemoryV3MigrationPreflightOverview> {
  return publicPreflight(await manager.preflight())
}

export async function requestMemoryV3Migration(
  manager: MemoryV2ToV3MigrationManager,
): Promise<MemoryV3MigrationPreflightOverview> {
  await manager.requestMigration()
  return inspectMemoryV3Migration(manager)
}

export async function cancelMemoryV3Operation(
  manager: MemoryV2ToV3MigrationManager,
): Promise<MemoryV3MigrationPreflightOverview> {
  await manager.cancelPending()
  return inspectMemoryV3Migration(manager)
}

export async function requestMemoryV3Rollback(
  manager: MemoryV2ToV3MigrationManager,
): Promise<MemoryV3MigrationPreflightOverview> {
  await manager.requestRollback()
  return inspectMemoryV3Migration(manager)
}

function publicPreflight(preflight: MemoryV3MigrationPreflight): MemoryV3MigrationPreflightOverview {
  const pending = preflight.locator.pendingMigration
    ? { kind: 'migration' as const, ...preflight.locator.pendingMigration }
    : preflight.locator.pendingRollback
      ? { kind: 'rollback' as const, ...preflight.locator.pendingRollback }
      : undefined
  return {
    checkedAt: preflight.checkedAt,
    activeBackend: preflight.locator.activeBackend,
    previousBackend: preflight.locator.previousBackend,
    pendingOperation: pending,
    requiresRestart: Boolean(pending),
    canCancel: pending?.kind === 'rollback'
      || pending?.phase === 'recovery'
      || (pending?.phase === 'requested' && pending.attempts === 0),
    canMigrate: preflight.canMigrate,
    canResume: preflight.canResume,
    rollbackAvailable: preflight.rollbackAvailable,
    blockers: preflight.blockers,
    source: preflight.source ? {
      fileCount: preflight.source.fileCount,
      totalBytes: preflight.source.totalBytes,
      nodeCount: preflight.source.nodeCount,
      resourceCount: preflight.source.resourceCount,
    } : undefined,
    storage: preflight.storage,
  }
}
