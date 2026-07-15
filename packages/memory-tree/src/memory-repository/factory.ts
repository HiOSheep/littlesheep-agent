// Selects a versioned repository backend and owns the explicit Memory v3 experiment gate.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryRepositoryBackend } from './backend.js';
import {
  MEMORY_V3_EXPERIMENT_MARKER,
  type MemoryRepositoryBackendKind,
  type MemoryRepositoryOptions,
  type MemoryV3ExperimentMarker,
} from './contracts.js';
import { MemoryRepositoryV2Backend } from './v2-backend.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';
import { resolveMemoryWritePolicy } from './write-policy.js';

export interface SelectedMemoryRepositoryBackend {
  kind: MemoryRepositoryBackendKind;
  backend: MemoryRepositoryBackend;
}

export function createMemoryRepositoryBackend(options: MemoryRepositoryOptions): SelectedMemoryRepositoryBackend {
  const kind = options.backend ?? 'v2';
  if (kind === 'v3' && !hasValidMemoryV3ExperimentMarker(options.dataDir)) {
    throw new Error(
      `Memory v3 requires an explicit isolated-data marker (${MEMORY_V3_EXPERIMENT_MARKER}); refusing to open this data root.`,
    );
  }
  const policy = resolveMemoryWritePolicy(options.policy);
  return {
    kind,
    backend: kind === 'v3'
      ? new MemoryRepositoryV3Backend({ dataDir: options.dataDir, policy, log: options.log, v3: options.v3 })
      : new MemoryRepositoryV2Backend({ dataDir: options.dataDir, policy, log: options.log }),
  };
}

function hasValidMemoryV3ExperimentMarker(dataDir: string): boolean {
  try {
    const marker = JSON.parse(
      readFileSync(join(dataDir, MEMORY_V3_EXPERIMENT_MARKER), 'utf8'),
    ) as Partial<MemoryV3ExperimentMarker>;
    return marker.version === 1
      && marker.purpose === 'isolated-memory-v3-evaluation'
      && typeof marker.createdAt === 'string'
      && Number.isFinite(Date.parse(marker.createdAt));
  } catch {
    return false;
  }
}

export async function createMemoryV3ExperimentMarker(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, MEMORY_V3_EXPERIMENT_MARKER), `${JSON.stringify({
    version: 1,
    purpose: 'isolated-memory-v3-evaluation',
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
