import type {
  MemoryAtom,
  MemoryAtomHistory,
  MemoryCatalogEntry,
  MemoryDisclosureLevel,
  MemoryEvidenceEnvelope,
  MemoryImmutableFact,
  MemoryRelationNeighborhood,
} from '../v3/contracts.js';
import type { MemoryRepositoryBackendKind } from './contracts.js';
import type { MemoryRepositoryBackend } from './backend.js';

export interface MemoryRepositoryEmbeddingStatusCounts {
  disabled: number;
  pending: number;
  ready: number;
  stale: number;
  failed: number;
}

export interface MemoryRepositoryManagementStatus {
  backendKind: MemoryRepositoryBackendKind;
  storageKind: 'legacy-index' | 'atom-catalog';
  retrievalSupported: boolean;
  catalog?: {
    integrity: string;
    atomCount: number;
    embedding: MemoryRepositoryEmbeddingStatusCounts;
  };
}

export interface MemoryRepositoryNodeInspection {
  backendKind: MemoryRepositoryBackendKind;
  nodeId: string;
  disclosureLevel: Extract<MemoryDisclosureLevel, 'D2' | 'D3'>;
  atom?: MemoryAtom;
  catalog?: MemoryCatalogEntry;
  envelope?: MemoryEvidenceEnvelope;
  neighborhood?: MemoryRelationNeighborhood;
  history?: MemoryAtomHistory;
  immutableFacts?: MemoryImmutableFact[];
}

export type MemoryAtomManagementRequest =
  | {
      action: 'move';
      atomId: string;
      expectedRevision: number;
      parentNodeId?: string;
      reason: string;
    }
  | {
      action: 'merge';
      atomId: string;
      expectedRevision: number;
      targetAtomId: string;
      targetExpectedRevision: number;
      reason: string;
    }
  | {
      action: 'invalidate' | 'reactivate';
      atomId: string;
      expectedRevision: number;
      reason: string;
    };

export interface MemoryAtomManagementAudit {
  id: string;
  action: MemoryAtomManagementRequest['action'];
  at: string;
  reason: string;
  atomIds: string[];
  before: Array<{
    atomId: string;
    revision: number;
    parentId?: string;
    status: MemoryAtom['status'];
    epistemicStatus: MemoryAtom['epistemicStatus'];
    resolutionStatus: MemoryAtom['resolutionStatus'];
  }>;
  after: Array<{
    atomId: string;
    revision: number;
    parentId?: string;
    status: MemoryAtom['status'];
    epistemicStatus: MemoryAtom['epistemicStatus'];
    resolutionStatus: MemoryAtom['resolutionStatus'];
  }>;
}

export interface MemoryAtomManagementResult {
  action: MemoryAtomManagementRequest['action'];
  atoms: MemoryAtom[];
  audit: MemoryAtomManagementAudit;
}

export interface MemoryRepositoryManagementFacade {
  status(): Promise<MemoryRepositoryManagementStatus>;
  inspectNode(
    nodeId: string,
    disclosureLevel: MemoryRepositoryNodeInspection['disclosureLevel'],
  ): Promise<MemoryRepositoryNodeInspection | undefined>;
  manageAtom(request: MemoryAtomManagementRequest): Promise<MemoryAtomManagementResult>;
}

export function createMemoryRepositoryManagementFacade(
  backend: MemoryRepositoryBackend,
): MemoryRepositoryManagementFacade {
  return {
    status: () => backend.managementStatus(),
    inspectNode: (nodeId, disclosureLevel) => backend.inspectNodeForManagement(nodeId, disclosureLevel),
    manageAtom: (request) => {
      if (!backend.manageAtomForManagement) {
        return Promise.reject(new Error('Advanced atom management requires the Memory v3 backend.'));
      }
      return backend.manageAtomForManagement(request);
    },
  };
}
