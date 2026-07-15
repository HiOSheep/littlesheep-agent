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
  MemoryV3BootstrapPreparation,
  MemoryV3MigrationFaultPoint,
  MemoryV3MigrationPreflight,
  MemoryV3MigrationResult,
  PrepareMemoryV3ForBootstrapOptions,
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
  type PendingMemoryV3Rollback,
} from './repository-locator.js';
import {
  assertMemoryV3MigrationCapacity,
  inspectMemoryV3MigrationPreflight,
} from './v3-migration-preflight.js';
import { MemoryV3MigrationOperationQueue } from './v3-migration-operation.js';

export type {
  MemoryV2ToV3MigrationManagerOptions,
  MemoryV3BootstrapPreparation,
  MemoryV3MigrationFaultContext,
  MemoryV3MigrationFaultPoint,
  MemoryV3MigrationPreflight,
  MemoryV3MigrationResult,
  PrepareMemoryV3ForBootstrapOptions,
} from './v3-migration-contracts.js';

export class MemoryV2ToV3MigrationManager {
  private readonly dataDir: string;
  private readonly policy: MemoryWritePolicy;
  private readonly v3?: MemoryRepositoryV3Options;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly availableBytes: (path: string) => Promise<number>;
  private readonly faultInjector?: MemoryV2ToV3MigrationManagerOptions['faultInjector'];
  private readonly operations = new MemoryV3MigrationOperationQueue();

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

  async preflight(): Promise<MemoryV3MigrationPreflight> {
    return inspectMemoryV3MigrationPreflight({
      dataDir: this.dataDir,
      locator: await this.status(),
      checkedAt: this.now().toISOString(),
      availableBytes: this.availableBytes,
    });
  }

  requestMigration(): Promise<MemoryRepositoryLocator> {
    return this.registerMigrationRequest(true);
  }

  requestRollback(): Promise<MemoryRepositoryLocator> {
    return this.operations.run(async () => {
      const locator = await this.status();
      if (locator.pendingMigration) throw new Error('A Memory v3 migration is already pending.');
      if (locator.pendingRollback) return locator;
      if (locator.activeBackend !== 'v3' || !locator.lastMigration) {
        throw new Error('Memory v3 is not the active migrated backend.');
      }
      const timestamp = this.now().toISOString();
      const next: MemoryRepositoryLocator = {
        ...locator,
        pendingRollback: {
          id: this.idFactory(),
          phase: 'requested',
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
      };
      await writeMemoryRepositoryLocator(this.dataDir, next);
      return next;
    });
  }

  cancelPending(): Promise<MemoryRepositoryLocator> {
    return this.operations.run(async () => {
      const locator = await this.status();
      const timestamp = this.now().toISOString();
      if (locator.pendingMigration) {
        const pending = locator.pendingMigration;
        if (pending.phase === 'recovery') {
          const paths = memoryV3MigrationPaths(this.dataDir, pending.id);
          await ensureMigrationOwnership(paths.migrationDir, pending.id, pending.createdAt);
          if (await migrationDirectoryExists(paths.activeV3Dir)) {
            if (await migrationDirectoryExists(paths.abandonedV3Dir)) {
              throw new Error('The failed Memory v3 directory is already preserved; refusing to overwrite it.');
            }
            await rename(paths.activeV3Dir, paths.abandonedV3Dir);
          }
        } else if (pending.phase !== 'requested' || pending.attempts !== 0) {
          throw new Error('A started Memory v3 migration cannot be cancelled; restart to resume recovery.');
        }
        const next = { ...locator, pendingMigration: undefined, updatedAt: timestamp };
        await writeMemoryRepositoryLocator(this.dataDir, next);
        return next;
      }
      if (locator.pendingRollback) {
        const next = { ...locator, pendingRollback: undefined, updatedAt: timestamp };
        await writeMemoryRepositoryLocator(this.dataDir, next);
        return next;
      }
      return locator;
    });
  }

  prepareForBootstrap(
    options: PrepareMemoryV3ForBootstrapOptions = {},
  ): Promise<MemoryV3BootstrapPreparation> {
    return this.operations.run(async () => {
      const locator = await this.status();
      if (locator.pendingMigration) {
        try {
          return { locator: await this.execute(locator, locator.pendingMigration), operation: 'migration' };
        } catch (error) {
          await this.recordMigrationRecovery(locator.pendingMigration.id, error);
          if (options.throwOnError) throw error;
          return { locator: await this.status(), operation: 'migration', error: errorMessage(error) };
        }
      }
      if (locator.pendingRollback) {
        try {
          return { locator: await this.executeRollback(locator, locator.pendingRollback), operation: 'rollback' };
        } catch (error) {
          await this.recordRollbackRecovery(locator.pendingRollback.id, error);
          if (options.throwOnError) throw error;
          return { locator: await this.status(), operation: 'rollback', error: errorMessage(error) };
        }
      }
      return { locator, operation: 'none' };
    });
  }

  async migrate(): Promise<MemoryV3MigrationResult> {
    const before = await this.status();
    if (before.activeBackend === 'v3' && before.lastMigration) {
      return { locator: before, migration: before.lastMigration, resumed: true };
    }
    const resumed = !!before.pendingMigration;
    await this.registerMigrationRequest(false);
    const prepared = await this.prepareForBootstrap({ throwOnError: true });
    if (prepared.locator.activeBackend !== 'v3' || !prepared.locator.lastMigration) {
      throw new Error('Memory v3 migration did not activate the v3 backend.');
    }
    return { locator: prepared.locator, migration: prepared.locator.lastMigration, resumed };
  }

  async rollback(): Promise<MemoryRepositoryLocator> {
    await this.requestRollback();
    return (await this.prepareForBootstrap({ throwOnError: true })).locator;
  }

  private registerMigrationRequest(validatePreflight: boolean): Promise<MemoryRepositoryLocator> {
    return this.operations.run(async () => {
      let locator = await this.status();
      if (locator.activeBackend === 'v3') return locator;
      if (locator.pendingRollback) throw new Error('A Memory v3 rollback is already pending.');
      if (locator.pendingMigration) return locator;
      if (validatePreflight) {
        const preflight = await inspectMemoryV3MigrationPreflight({
          dataDir: this.dataDir,
          locator,
          checkedAt: this.now().toISOString(),
          availableBytes: this.availableBytes,
        });
        if (!preflight.canMigrate) {
          throw new Error(preflight.blockers[0] ?? 'Memory v3 migration preflight did not pass.');
        }
      }
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
      return locator;
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
    const inactiveExists = await migrationDirectoryExists(paths.inactiveV3Dir);
    if (activeExists && pending.validationHash) {
      if (stageExists) {
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
    if (activeExists) {
      if (stageExists || inactiveExists || locator.previousBackend !== 'v3' || !locator.lastMigration) {
        throw new Error('An inactive Memory v3 directory cannot be safely preserved for a new migration.');
      }
      await rename(paths.activeV3Dir, paths.inactiveV3Dir);
    }

    await removeOwnedMigrationChild(paths, paths.snapshotDir);
    await removeOwnedMigrationChild(paths, paths.stageDataDir);
    const source = await inspectMemoryV2Source(this.dataDir);
    await assertMemoryV3MigrationCapacity(this.dataDir, source.manifest.totalBytes, this.availableBytes);
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

  private async executeRollback(
    locator: MemoryRepositoryLocator,
    pendingValue: PendingMemoryV3Rollback,
  ): Promise<MemoryRepositoryLocator> {
    if (!locator.lastMigration) throw new Error('Memory v3 rollback has no completed migration evidence.');
    let pending: PendingMemoryV3Rollback = {
      ...pendingValue,
      attempts: pendingValue.attempts + 1,
      updatedAt: this.now().toISOString(),
      error: undefined,
    };
    pending = await this.persistPendingRollback(locator, pending, 'validating');
    const paths = memoryV3MigrationPaths(this.dataDir, locator.lastMigration.id);
    const snapshot = await loadMemoryV2Snapshot(paths.snapshotDir);
    const currentSource = await inspectMemoryV2Source(this.dataDir);
    assertSameManifest(
      snapshot.manifest,
      currentSource.manifest,
      'Memory v2 changed after migration; automatic rollback is unsafe.',
    );
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
    pending = await this.persistPendingRollback(locator, pending, 'committing');
    const rolledBack: MemoryRepositoryLocator = {
      ...locator,
      activeBackend: 'v2',
      previousBackend: 'v3',
      pendingMigration: undefined,
      pendingRollback: undefined,
      updatedAt: this.now().toISOString(),
    };
    await writeMemoryRepositoryLocator(this.dataDir, rolledBack);
    return rolledBack;
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
      pendingRollback: undefined,
      updatedAt: next.updatedAt,
    });
    return next;
  }

  private async persistPendingRollback(
    locator: MemoryRepositoryLocator,
    pending: PendingMemoryV3Rollback,
    phase: PendingMemoryV3Rollback['phase'],
  ): Promise<PendingMemoryV3Rollback> {
    const next = { ...pending, phase, updatedAt: this.now().toISOString() };
    await writeMemoryRepositoryLocator(this.dataDir, {
      ...locator,
      activeBackend: 'v3',
      pendingMigration: undefined,
      pendingRollback: next,
      updatedAt: next.updatedAt,
    });
    return next;
  }

  private async recordMigrationRecovery(id: string, error: unknown): Promise<void> {
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

  private async recordRollbackRecovery(id: string, error: unknown): Promise<void> {
    const locator = await readMemoryRepositoryLocator(this.dataDir).catch(() => undefined);
    if (!locator?.pendingRollback || locator.pendingRollback.id !== id) return;
    const timestamp = this.now().toISOString();
    await writeMemoryRepositoryLocator(this.dataDir, {
      ...locator,
      pendingRollback: {
        ...locator.pendingRollback,
        phase: 'recovery',
        updatedAt: timestamp,
        error: errorMessage(error).slice(0, 16_000),
      },
      updatedAt: timestamp,
    });
  }

  private fault(point: MemoryV3MigrationFaultPoint, paths: MemoryV3MigrationPaths, atomId?: string): Promise<void> {
    return Promise.resolve(this.faultInjector?.(point, { ...paths, atomId }));
  }

}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
