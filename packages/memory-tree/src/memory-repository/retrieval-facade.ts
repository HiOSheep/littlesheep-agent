import type { MemoryAccessRecord } from '../v3/contracts.js';
import type { MemoryRepositoryBackend } from './backend.js';
import type {
  MemoryRepositoryCandidate,
  MemoryRepositoryIndexRequest,
  MemoryRepositoryRetrievalRequest,
} from './retrieval.js';

export interface MemoryRepositoryRetrievalFacade {
  readonly supported: boolean;
  indexMemory(request: MemoryRepositoryIndexRequest): Promise<MemoryRepositoryCandidate[] | undefined>;
  retrieveMemory(request: MemoryRepositoryRetrievalRequest): Promise<MemoryRepositoryCandidate[] | undefined>;
  recordAccess(records: MemoryAccessRecord[]): Promise<void>;
}

export function createMemoryRepositoryRetrievalFacade(
  backend: MemoryRepositoryBackend,
): MemoryRepositoryRetrievalFacade {
  return {
    supported: typeof backend.indexMemory === 'function' && typeof backend.retrieveMemory === 'function',
    indexMemory: (request) => backend.indexMemory?.(request) ?? Promise.resolve(undefined),
    retrieveMemory: (request) => backend.retrieveMemory?.(request) ?? Promise.resolve(undefined),
    recordAccess: (records) => Promise.resolve(backend.recordMemoryAccess?.(records)),
  };
}
