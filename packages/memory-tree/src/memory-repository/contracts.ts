import type {
  LogFn,
  MemoryBranchKind,
  MemoryResourceManagementActor,
  MemoryResourceRegistration,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';

export interface MemoryRepositoryOptions {
  dataDir: string;
  policy?: Partial<MemoryWritePolicy>;
  log?: LogFn;
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
