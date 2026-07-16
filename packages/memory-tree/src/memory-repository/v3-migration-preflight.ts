// Computes read-only migration readiness without creating locator, snapshot, or staging files.

import { inspectMemoryV2Source } from './v3-migration-source.js';
import type { MemoryV3MigrationPreflight } from './v3-migration-contracts.js';
import type { MemoryRepositoryLocator } from './repository-locator.js';

const MIN_FREE_BYTES = 16 * 1024 * 1024;

export interface InspectMemoryV3MigrationPreflightOptions {
  dataDir: string;
  locator: MemoryRepositoryLocator;
  checkedAt: string;
  availableBytes: (path: string) => Promise<number>;
}

export async function inspectMemoryV3MigrationPreflight(
  options: InspectMemoryV3MigrationPreflightOptions,
): Promise<MemoryV3MigrationPreflight> {
  const blockers: string[] = [];
  let source: MemoryV3MigrationPreflight['source'];
  let storage: MemoryV3MigrationPreflight['storage'];
  try {
    const inspected = await inspectMemoryV2Source(options.dataDir);
    const availableBytes = await options.availableBytes(options.dataDir);
    const requiredBytes = requiredMemoryV3MigrationBytes(inspected.manifest.totalBytes);
    source = {
      fileCount: inspected.manifest.fileCount,
      totalBytes: inspected.manifest.totalBytes,
      nodeCount: Object.values(inspected.document.nodes).filter((node) => !node.isBranchRoot).length,
      resourceCount: Object.keys(inspected.document.resources).length,
      indexHash: inspected.indexHash,
      manifestHash: inspected.manifest.manifestHash,
    };
    storage = { requiredBytes, availableBytes };
    if (availableBytes < requiredBytes) {
      blockers.push(`Memory v3 migration requires ${requiredBytes} free bytes but only ${availableBytes} are available.`);
    }
  } catch (error) {
    blockers.push(errorMessage(error));
  }
  const alreadyV3 = options.locator.activeBackend === 'v3';
  return {
    checkedAt: options.checkedAt,
    locator: options.locator,
    canMigrate: !alreadyV3
      && !options.locator.pendingMigration
      && !options.locator.pendingRollback
      && blockers.length === 0,
    canResume: !alreadyV3 && Boolean(options.locator.pendingMigration) && blockers.length === 0,
    rollbackAvailable: false,
    blockers,
    source,
    storage,
  };
}

export function requiredMemoryV3MigrationBytes(sourceBytes: number): number {
  return Math.max(MIN_FREE_BYTES, sourceBytes * 4 + MIN_FREE_BYTES);
}

export async function assertMemoryV3MigrationCapacity(
  dataDir: string,
  sourceBytes: number,
  availableBytes: (path: string) => Promise<number>,
): Promise<void> {
  const required = requiredMemoryV3MigrationBytes(sourceBytes);
  const available = await availableBytes(dataDir);
  if (available >= required) return;
  const error = new Error(`Memory v3 migration requires ${required} free bytes but only ${available} are available.`);
  Object.assign(error, { code: 'ENOSPC' });
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
