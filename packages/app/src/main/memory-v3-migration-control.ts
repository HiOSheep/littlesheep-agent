// Read-only Memory v3 migration status for the management UI.

import { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import type { MemoryV3MigrationPreflightOverview } from '../shared/memory-control-contracts.js'

export async function inspectMemoryV3Migration(dataDir: string): Promise<MemoryV3MigrationPreflightOverview> {
  const preflight = await new MemoryV2ToV3MigrationManager({ dataDir }).preflight()
  return {
    checkedAt: preflight.checkedAt,
    activeBackend: preflight.locator.activeBackend,
    previousBackend: preflight.locator.previousBackend,
    phase: preflight.locator.pendingMigration?.phase,
    attempts: preflight.locator.pendingMigration?.attempts,
    error: preflight.locator.pendingMigration?.error,
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
