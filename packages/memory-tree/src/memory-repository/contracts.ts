import type {
  LogFn,
  MemoryBranchKind,
  MemoryResourceManagementActor,
  MemoryResourceRegistration,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import type { EmbeddingEngine } from '../v3/contracts.js';

export type MemoryRepositoryBackendKind = 'v2' | 'v3';

export interface MemoryRepositoryV3Options {
  embeddingEngine?: EmbeddingEngine;
  allowRemoteEmbedding?: boolean;
  maxEmbeddingBatchSize?: number;
  maxDueBatchSize?: number;
}

export const MEMORY_V3_EXPERIMENT_MARKER = '.memory-v3-experiment.json';

export interface MemoryV3ExperimentMarker {
  version: 1;
  purpose: 'isolated-memory-v3-evaluation';
  createdAt: string;
}

export interface MemoryRepositoryOptions {
  dataDir: string;
  backend?: MemoryRepositoryBackendKind;
  policy?: Partial<MemoryWritePolicy>;
  log?: LogFn;
  v3?: MemoryRepositoryV3Options;
}

export interface ReplaceMemoryResourceGroupOptions {
  staleMode?: 'missing' | 'remove';
  audit?: boolean;
  reason?: string;
  /** Owner-controlled groups can intentionally restore a previously disabled resource. */
  preserveDisabled?: boolean;
}

export interface ManageMemoryResourceOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  audit?: boolean;
  restoreStatus?: Exclude<MemoryResourceRegistration['status'], 'disabled'>;
  allowActiveRemoval?: boolean;
}

export interface RebindMemoryResourceOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  replaceConflictingResource?: boolean;
}

export interface RemoveMemoryResourcesOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  audit?: boolean;
  includeActive?: boolean;
}

export interface MemoryRepositoryWriter {
  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult>;
}

export interface MemoryWriteServiceOptions {
  repository: MemoryRepositoryWriter;
  invalidate: (branch: MemoryBranchKind) => void | Promise<void>;
  log?: LogFn;
}
