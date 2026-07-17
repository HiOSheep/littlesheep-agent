import type {
  CompactionSummary,
  RunAttachment,
  RuntimeEventEnvelope,
  SessionId,
} from '@littlesheep/types';
import type { MemoryRepository, MemoryWriteService } from '../memory-repository.js';
import type { MemoryTree } from '../memory-tree.js';
import type {
  BranchDescription,
  BranchIndex,
  LogFn,
  MemoryAccessLedger,
  MemoryExpandOptions,
  MemoryQueryResult,
  MemoryReleaseResult,
  MemoryFragment,
  MemoryResourceOwnerKind,
  MemoryResourceRegistration,
  MemorySearchOptions,
  MemoryTreeDocument,
} from '../types.js';
import type { MemoryTaskQuery } from '../task-query.js';
import type { WorkspaceResourceIndexLimits } from '../workspace-resource-index.js';

export interface MemoryServiceOptions {
  tree: MemoryTree;
  repository: MemoryRepository;
  writer: MemoryWriteService;
  dataDir: string;
  rootIndexMaxChars: number;
  resolveSessionSummary?: (
    sessionId: SessionId,
    summaryId: string,
  ) => Promise<CompactionSummary | undefined>;
  resolveRuntimeEvents?: (
    runId: string,
  ) => Promise<ReadonlyArray<RuntimeEventEnvelope> | undefined>;
  workspaceIndexLimits?: Partial<WorkspaceResourceIndexLimits>;
  log?: LogFn;
}

export interface MemoryRunStart {
  rootIndex: string;
  ledger: MemoryAccessLedger;
  initialContext?: MemoryRunContextSelection;
  continuitySummaryId?: string;
}

export interface MemoryRunContextSelection {
  content: string;
  atomIds: string[];
  fragments: MemoryFragment[];
}

export interface MemoryRunRefinementInput {
  runId: string;
  query: string;
  taskQuery?: MemoryTaskQuery;
  purpose: 'taskbook' | 'replan';
  maxAtoms?: number;
  tokenBudget?: number;
}

export interface MemoryRunRefinement {
  ledger: MemoryAccessLedger;
  context?: MemoryRunContextSelection;
  skippedReason?: 'empty-query' | 'duplicate-query' | 'refinement-limit';
}

export interface MemoryRunRefinementServiceLike {
  refineRun(input: MemoryRunRefinementInput): Promise<MemoryRunRefinement>;
}

export interface MemoryManagementSnapshot {
  document: MemoryTreeDocument;
  branches: BranchDescription[];
  ledgers: MemoryAccessLedger[];
  resources: MemoryResourceRegistration[];
}

export interface MemorySkillResourceInput {
  name: string;
  description: string;
  whenToUse?: string;
  dir: string;
  source: MemorySkillSourceInput;
  availability: 'active' | 'disabled' | 'shadowed';
}

export interface MemorySkillSourceInput {
  id: string;
  kind: MemoryResourceOwnerKind;
  dir: string;
  ownerId?: string;
  enabled?: boolean;
}

export interface SyncMemorySkillResourcesOptions {
  /** Only these owner kinds are reconciled; other skill owners remain untouched. */
  ownerKinds?: MemoryResourceOwnerKind[];
}

export interface MemoryRunResourceInput {
  runId: string;
  sessionId: SessionId;
  workspace: string;
  summary?: CompactionSummary;
  attachments?: RunAttachment[];
  runtimeEvents?: ReadonlyArray<RuntimeEventEnvelope>;
}

export interface MemoryNavigationServiceLike {
  rootIndex(): string | Promise<string>;
  branchIndex(runId: string, branchId: string): Promise<BranchIndex>;
  expand(runId: string, options: MemoryExpandOptions): Promise<MemoryQueryResult>;
  deepSearch(runId: string, options: MemorySearchOptions): Promise<MemoryQueryResult>;
  release?(runId: string, atomIds: string[]): Promise<MemoryReleaseResult>;
}

export interface MemoryBootstrapServiceLike {
  loadBootstrapFiles(dir: string): Promise<Record<string, string>>;
}
