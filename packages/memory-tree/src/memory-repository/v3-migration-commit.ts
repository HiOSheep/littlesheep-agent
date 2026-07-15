// Finalizes an already verified Memory v3 directory and recovers interrupted commits.

import { relative } from 'node:path';
import type { MemoryWritePolicy } from '../types.js';
import type { MemoryRepositoryV3Options } from './contracts.js';
import {
  assertSameManifest,
  inspectMemoryV2Source,
  loadMemoryV2Snapshot,
} from './v3-migration-source.js';
import { validateMemoryV3Stage } from './v3-migration-validation.js';
import type { MemoryV3MigrationPaths } from './v3-migration-files.js';
import {
  writeMemoryRepositoryLocator,
  type CompletedMemoryV3Migration,
  type MemoryRepositoryLocator,
  type PendingMemoryV3Migration,
} from './repository-locator.js';

export interface MemoryV3CommitOptions {
  dataDir: string;
  locator: MemoryRepositoryLocator;
  pending: PendingMemoryV3Migration;
  paths: MemoryV3MigrationPaths;
  policy: MemoryWritePolicy;
  v3?: MemoryRepositoryV3Options;
  now: () => Date;
}

export async function finishInterruptedMemoryV3Commit(
  options: MemoryV3CommitOptions,
): Promise<MemoryRepositoryLocator> {
  const snapshot = await loadMemoryV2Snapshot(options.paths.snapshotDir);
  const currentSource = await inspectMemoryV2Source(options.dataDir);
  assertSameManifest(snapshot.manifest, currentSource.manifest, 'Memory v2 changed during interrupted commit recovery.');
  const validation = await validateMemoryV3Stage(
    options.dataDir,
    snapshot.document,
    snapshot.manifest.manifestHash,
    options.policy,
    options.v3,
  );
  if (validation.validationHash !== options.pending.validationHash) {
    throw new Error('Interrupted Memory v3 commit does not match its verified staging hash.');
  }
  return commitMemoryV3Locator(options);
}

export async function commitMemoryV3Locator(options: MemoryV3CommitOptions): Promise<MemoryRepositoryLocator> {
  const { pending } = options;
  if (!pending.sourceIndexHash || !pending.sourceManifestHash || !pending.snapshotManifestHash
    || !pending.validationHash || pending.nodeCount === undefined || pending.resourceCount === undefined) {
    throw new Error('Memory v3 migration cannot commit without complete verification evidence.');
  }
  const completedAt = options.now().toISOString();
  const migration: CompletedMemoryV3Migration = {
    id: pending.id,
    sourceIndexHash: pending.sourceIndexHash,
    sourceManifestHash: pending.sourceManifestHash,
    snapshotManifestHash: pending.snapshotManifestHash,
    validationHash: pending.validationHash,
    nodeCount: pending.nodeCount,
    resourceCount: pending.resourceCount,
    snapshotRelativePath: relative(options.dataDir, options.paths.snapshotDir).replace(/\\/gu, '/'),
    completedAt,
  };
  const next: MemoryRepositoryLocator = {
    ...options.locator,
    activeBackend: 'v3',
    previousBackend: 'v2',
    pendingMigration: undefined,
    lastMigration: migration,
    updatedAt: completedAt,
  };
  await writeMemoryRepositoryLocator(options.dataDir, next);
  return next;
}
