import type {
  MemoryAtom,
  MemoryAtomHistory,
  MemoryCatalogEntry,
  MemoryDisclosureLevel,
  MemoryEvidenceEnvelope,
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
}

export interface MemoryRepositoryManagementFacade {
  status(): Promise<MemoryRepositoryManagementStatus>;
  inspectNode(
    nodeId: string,
    disclosureLevel: MemoryRepositoryNodeInspection['disclosureLevel'],
  ): Promise<MemoryRepositoryNodeInspection | undefined>;
}

export function createMemoryRepositoryManagementFacade(
  backend: MemoryRepositoryBackend,
): MemoryRepositoryManagementFacade {
  return {
    status: () => backend.managementStatus(),
    inspectNode: (nodeId, disclosureLevel) => backend.inspectNodeForManagement(nodeId, disclosureLevel),
  };
}
