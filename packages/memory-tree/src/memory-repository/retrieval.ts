import type {
  MemoryAccessRecord,
  MemoryAtom,
  MemoryAtomHistory,
  MemoryCandidatePriorityBreakdown,
  MemoryDisclosureLevel,
  MemoryEvidenceEnvelope,
  MemoryRelationNeighborhood,
} from '../v3/contracts.js';
import type { MemoryBranchKind, MemoryScope } from '../types.js';

export interface MemoryRetrievalScope {
  scope: MemoryScope;
  scopeKey?: string;
}

export interface MemoryRepositoryIndexRequest {
  branch: MemoryBranchKind;
  scopes: MemoryRetrievalScope[];
  query: string;
  limit: number;
  now: string;
  signal?: AbortSignal;
  parentNodeId?: string;
}

export interface MemoryRepositoryRetrievalRequest extends MemoryRepositoryIndexRequest {
  nodeId?: string;
  subtreeRootId?: string;
  disclosureLevel: Extract<MemoryDisclosureLevel, 'D2' | 'D3'>;
  mode: 'expand' | 'deep-search';
}

export interface MemoryRepositoryCandidate {
  atom: MemoryAtom;
  envelope: MemoryEvidenceEnvelope;
  priority: MemoryCandidatePriorityBreakdown;
  retrievalPath: Extract<MemoryAccessRecord['path'], 'hierarchy' | 'fts' | 'vector'>;
  hasChildren: boolean;
  neighborhood?: MemoryRelationNeighborhood;
  history?: MemoryAtomHistory;
}

export interface MemoryRepositoryRetrievalBackend {
  indexMemory(request: MemoryRepositoryIndexRequest): Promise<MemoryRepositoryCandidate[]>;
  retrieveMemory(request: MemoryRepositoryRetrievalRequest): Promise<MemoryRepositoryCandidate[]>;
  recordMemoryAccess(records: MemoryAccessRecord[]): Promise<void> | void;
}
