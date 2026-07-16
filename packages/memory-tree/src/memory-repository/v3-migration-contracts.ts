// Public contracts for the isolated Memory v2 -> v3 migration manager.

import type { MemoryTreeDocument, MemoryWritePolicy } from '../types.js';
import type { MemoryRepositoryV3Options } from './contracts.js';
import type { CompletedMemoryV3Migration, MemoryRepositoryLocator } from './repository-locator.js';

export type MemoryV3MigrationFaultPoint =
  | 'after-snapshot'
  | 'after-stage-initialized'
  | 'after-ledger-import'
  | 'after-atom-write'
  | 'after-stage-build'
  | 'after-validation'
  | 'before-active-v3-commit'
  | 'after-active-v3-commit'
  | 'after-locator-commit';

export interface MemoryV3MigrationFaultContext {
  migrationId: string;
  dataDir: string;
  migrationDir: string;
  stageDataDir: string;
  activeV3Dir: string;
  inactiveV3Dir: string;
  abandonedV3Dir: string;
  atomId?: string;
}

export interface MemoryV2ToV3MigrationManagerOptions {
  dataDir: string;
  policy?: Partial<MemoryWritePolicy>;
  v3?: MemoryRepositoryV3Options;
  now?: () => Date;
  idFactory?: () => string;
  availableBytes?: (path: string) => Promise<number>;
  faultInjector?: (
    point: MemoryV3MigrationFaultPoint,
    context: MemoryV3MigrationFaultContext,
  ) => void | Promise<void>;
}

export interface MemoryV3MigrationResult {
  locator: MemoryRepositoryLocator;
  migration: CompletedMemoryV3Migration;
  resumed: boolean;
}

export interface MemoryV3BootstrapPreparation {
  locator: MemoryRepositoryLocator;
  operation: 'none' | 'migration' | 'rollback';
  error?: string;
}

export interface PrepareMemoryV3ForBootstrapOptions {
  throwOnError?: boolean;
}

export interface MemoryV3MigrationPreflight {
  checkedAt: string;
  locator: MemoryRepositoryLocator;
  canMigrate: boolean;
  canResume: boolean;
  rollbackAvailable: boolean;
  rollback?: MemoryV3RollbackReadiness;
  blockers: string[];
  source?: {
    fileCount: number;
    totalBytes: number;
    nodeCount: number;
    resourceCount: number;
    indexHash: string;
    manifestHash: string;
  };
  storage?: {
    requiredBytes: number;
    availableBytes: number;
  };
}

export interface MemoryV3MigrationValidation {
  validationHash: string;
  nodeCount: number;
  resourceCount: number;
  atomCount: number;
  pendingEmbeddingCount: number;
  catalogIntegrity: string;
}

export type MemoryV3ActiveStateValidator = (
  source: MemoryTreeDocument,
  sourceManifestHash: string,
) => Promise<MemoryV3MigrationValidation>;

export interface MemoryV3PreflightOptions {
  validateActiveV3?: MemoryV3ActiveStateValidator;
}

export interface MemoryV3RollbackReadiness {
  canRollback: boolean;
  sourceUnchanged: boolean;
  activeV3Unchanged: boolean;
  blockers: string[];
}
