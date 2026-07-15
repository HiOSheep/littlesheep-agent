// Coordinates resumable, same-volume Memory v2 -> v3 staging, commit, and rollback.

import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MemoryWritePolicy } from '../types.js';
import type { MemoryRepositoryV3Options } from './contracts.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import {
  assertSameManifest,
  inspectMemoryV2Source,
  loadMemoryV2Snapshot,
  writeMemoryV2Snapshot,
} from './v3-migration-source.js';
import { buildMemoryV3Stage } from './v3-migration-build.js';
import { validateMemoryV3Stage } from './v3-migration-validation.js';
import { commitMemoryV3Locator, finishInterruptedMemoryV3Commit } from './v3-migration-commit.js';
import type {
  MemoryV2ToV3MigrationManagerOptions,
  MemoryV3MigrationFaultPoint,
  MemoryV3MigrationResult,
} from './v3-migration-contracts.js';
import {
  availableFilesystemBytes,
  ensureMigrationOwnership,
  memoryV3MigrationPaths,
  migrationDirectoryExists,
  removeOwnedMigrationChild,
  type MemoryV3MigrationPaths,
} from './v3-migration-files.js';
import {
  createDefaultMemoryRepositoryLocator,
  readMemoryRepositoryLocator,
  writeMemoryRepositoryLocator,
  type MemoryRepositoryLocator,
  type PendingMemoryV3Migration,
} from './repository-locator.js';

const MIN_FREE_BYTES = 16 * 1024 * 1024;

export type { MemoryV2ToV3MigrationManagerOptions, MemoryV3MigrationFaultContext, MemoryV3MigrationFaultPoint, MemoryV3MigrationResult } from './v3-migration-contracts.js';

export class MemoryV2ToV3MigrationManager {
  private readonly dataDir: string;
  private readonly policy: MemoryWritePolicy;
  private readonly v3?: MemoryRepositoryV3Options;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly availableBytes: (path: string) => Promise<number>;
  private readonly faultInjector?: MemoryV2ToV3MigrationManagerOptions['faultInjector'];
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: MemoryV2ToV3MigrationManagerOptions) {
    this.dataDir = resolve(options.dataDir);
    this.policy = resolveMemoryWritePolicy(options.policy);
    this.v3 = options.v3;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.availableBytes = options.availableBytes ?? availableFilesystemBytes;
    this.faultInjector = options.faultInjector;
  }

  async status(): Promise<MemoryRepositoryLocator> {
    return await readMemoryRepositoryLocator(this.dataDir)
      ?? createDefaultMemoryRepositoryLocator(this.now().toISOString());
  }

  migrate(): Promise<MemoryV3MigrationResult> {
    return this.serialize(async () => {
      let locator = await this.status();
      if (locator.activeBackend === 'v3' && locator.lastMigration) {
        return { locator, migration: locator.lastMigration, resumed: true };
      }
      const resumed = !!locator.pendingMigration;
      if (!locator.pendingMigration) {
        const timestamp = this.now().toISOString();
        locator = {
          ...locator,
          activeBackend: 'v2',
          pendingMigration: {
            id: this.idFactory(),
            phase: 'requested',
            attempts: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          updatedAt: timestamp,
        };
        await writeMemoryRepositoryLocator(this.dataDir, locator);
      }
      try {
        const completed = await this.execute(locator, locator.pendingMigration!);
        return { locator: completed, migration: completed.lastMigration!, resumed };
      } catch (error) {
        await this.recordRecovery(locator.pendingMigration!.id, error);
        throw error;
      }
    });
  }

  rollback(): Promise<MemoryRepositoryLocator> {
    return this.serialize(async () => {
      const locator = await this.status();
      if (locator.activeBackend !== 'v3' || !locator.lastMigration) {
        throw new Error('Memory v3 is not the active migrated backend.');
      }
      const paths = memoryV3MigrationPaths(this.dataDir, locator.lastMigration.id);
      const snapshot = await loadMemoryV2Snapshot(paths.snapshotDir);
      const currentSource = await inspectMemoryV2Source(this.dataDir);
      assertSameManifest(snapshot.manifest, currentSource.manifest, 'Memory v2 changed after migration; automatic rollback is unsafe.');
      const active = await validateMemoryV3Stage(
        this.dataDir,
        snapshot.document,
        snapshot.manifest.manifestHash,
        this.policy,
        this.v3,
      );
      if (active.validationHash !== locator.lastMigration.validationHash) {
        throw new Error('Memory v3 changed after migration; automatic rollback would lose data.');
      }
      const rolledBack: MemoryRepositoryLocator = {
        ...locator,
        activeBackend: 'v2',
        previousBackend: 'v3',
        pendingMigration: undefined,
        updatedAt: this.now().toISOString(),
      };
      await writeMemoryRepositoryLocator(this.dataDir, rolledBack);
      return rolledBack;
    });
  }

  private async execute(
    locator: MemoryRepositoryLocator,
    pendingValue: PendingMemoryV3Migration,
  ): Promise<MemoryRepositoryLocator> {
    let pending: PendingMemoryV3Migration = {
      ...pendingValue,
      attempts: pendingValue.attempts + 1,
      updatedAt: this.now().toISOString(),
      error: undefined,
    };
    const paths = memoryV3MigrationPaths(this.dataDir, pending.id);
    await ensureMigrationOwnership(paths.migrationDir, pending.id, this.now().toISOString());
    const activeExists = await migrationDirectoryExists(paths.activeV3Dir);
    const stageExists = await migrationDirectoryExists(paths.stageV3Dir);
    if (activeExists) {
      if (!pending.validationHash || stageExists) {
        throw new Error('An uncommitted Memory v3 directory already exists; refusing to overwrite it.');
      }
      return finishInterruptedMemoryV3Commit({
        dataDir: this.dataDir,
        locator,
        pending,
        paths,
        policy: this.policy,
        v3: this.v3,
        now: this.now,
      });
    }

    await removeOwnedMigrationChild(paths, paths.snapshotDir);
    await removeOwnedMigrationChild(paths, paths.stageDataDir);
    const source = await inspectMemoryV2Source(this.dataDir);
    await this.assertDiskCapacity(source.manifest.totalBytes);
    pending = await this.persistPending(locator, pending, 'snapshot', {
      sourceIndexHash: source.indexHash,
      sourceManifestHash: source.manifest.manifestHash,
    });
    const snapshotManifest = await writeMemoryV2Snapshot(source, paths.snapshotDir);
    pending = await this.persistPending(locator, pending, 'snapshot', {
      snapshotManifestHash: snapshotManifest.manifestHash,
      nodeCount: Object.values(source.document.nodes).filter((node) => !node.isBranchRoot).length,
      resourceCount: Object.keys(source.document.resources).length,
    });
    await this.fault('after-snapshot', paths);

    pending = await this.persistPending(locator, pending, 'building');
    await buildMemoryV3Stage({
      dataDir: paths.stageDataDir,
      source: source.document,
      policy: this.policy,
      v3: this.v3,
      onCheckpoint: async (checkpoint, context) => {
        if (checkpoint === 'stage-initialized') await this.fault('after-stage-initialized', paths);
        if (checkpoint === 'ledger-imported') await this.fault('after-ledger-import', paths);
        if (checkpoint === 'atom-written') await this.fault('after-atom-write', paths, context.atomId);
      },
    });
    await this.fault('after-stage-build', paths);

    pending = await this.persistPending(locator, pending, 'validating');
    const validation = await validateMemoryV3Stage(
      paths.stageDataDir,
      source.document,
      source.manifest.manifestHash,
      this.policy,
      this.v3,
    );
    pending = await this.persistPending(locator, pending, 'ready', {
      validationHash: validation.validationHash,
      nodeCount: validation.nodeCount,
      resourceCount: validation.resourceCount,
    });
    await this.fault('after-validation', paths);

    const currentSource = await inspectMemoryV2Source(this.dataDir);
    assertSameManifest(source.manifest, currentSource.manifest, 'Memory v2 changed before the v3 commit; migration must restart.');
    pending = await this.persistPending(locator, pending, 'committing');
    await this.fault('before-active-v3-commit', paths);
    await mkdir(join(this.dataDir, 'memory-tree'), { recursive: true });
    await rename(paths.stageV3Dir, paths.activeV3Dir);
    await this.fault('after-active-v3-commit', paths);

    const active = await validateMemoryV3Stage(
      this.dataDir,
      source.document,
      source.manifest.manifestHash,
      this.policy,
      this.v3,
    );
    if (active.validationHash !== validation.validationHash) {
      throw new Error('Committed Memory v3 validation differs from the verified staging build.');
    }
    const completed = await commitMemoryV3Locator({
      dataDir: this.dataDir,
      locator,
      pending,
      paths,
      policy: this.policy,
      v3: this.v3,
      now: this.now,
    });
    await this.fault('after-locator-commit', paths);
    return completed;
  }

  private async persistPending(
    locator: MemoryRepositoryLocator,
    pending: PendingMemoryV3Migration,
    phase: PendingMemoryV3Migration['phase'],
    patch: Partial<PendingMemoryV3Migration> = {},
  ): Promise<PendingMemoryV3Migration> {
    const next = { ...pending, ...patch, phase, updatedAt: this.now().toISOString() };
    await writeMemoryRepositoryLocator(this.dataDir, {
      ...locator,
      activeBackend: 'v2',
      pendingMigration: next,
      updatedAt: next.updatedAt,
    });
    return next;
  }

  private async recordRecovery(id: string, error: unknown): Promise<void> {
    const locator = await readMemoryRepositoryLocator(this.dataDir).catch(() => undefined);
    if (!locator?.pendingMigration || locator.pendingMigration.id !== id) return;
    const timestamp = this.now().toISOString();
    await writeMemoryRepositoryLocator(this.dataDir, {
      ...locator,
      pendingMigration: {
        ...locator.pendingMigration,
        phase: 'recovery',
        updatedAt: timestamp,
        error: errorMessage(error).slice(0, 16_000),
      },
      updatedAt: timestamp,
    });
  }

  private async assertDiskCapacity(sourceBytes: number): Promise<void> {
    const required = Math.max(MIN_FREE_BYTES, sourceBytes * 4 + MIN_FREE_BYTES);
    const available = await this.availableBytes(this.dataDir);
    if (available < required) {
      const error = new Error(`Memory v3 migration requires ${required} free bytes but only ${available} are available.`);
      Object.assign(error, { code: 'ENOSPC' });
      throw error;
    }
  }

  private fault(point: MemoryV3MigrationFaultPoint, paths: MemoryV3MigrationPaths, atomId?: string): Promise<void> {
    return Promise.resolve(this.faultInjector?.(point, { ...paths, atomId }));
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.operationTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    this.operationTail = prior.then(() => gate);
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
