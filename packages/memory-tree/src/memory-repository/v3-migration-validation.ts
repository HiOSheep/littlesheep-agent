// Verifies a staged or committed Memory v3 repository against its immutable v2 snapshot.

import type { MemoryTreeDocument, MemoryWritePolicy } from '../types.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';
import type { MemoryRepositoryV3Options } from './contracts.js';
import type { MemoryV3MigrationValidation } from './v3-migration-contracts.js';
import { validateMemoryV3RepositoryState } from './v3-migration-validation-state.js';

export type { MemoryV3MigrationValidation } from './v3-migration-contracts.js';

export async function validateMemoryV3Stage(
  dataDir: string,
  source: MemoryTreeDocument,
  sourceManifestHash: string,
  policy: MemoryWritePolicy,
  v3?: MemoryRepositoryV3Options,
): Promise<MemoryV3MigrationValidation> {
  const backend = new MemoryRepositoryV3Backend({ dataDir, policy, v3 });
  try {
    await backend.initialize();
    return await validateMemoryV3RepositoryState(backend, source, sourceManifestHash);
  } finally {
    backend.close();
  }
}
