// Builds a Memory v3 repository inside an isolated staging data root.

import type { MemoryNode, MemoryResourceRegistration, MemoryTreeDocument, MemoryWritePolicy } from '../types.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';
import type { MemoryRepositoryV3Options } from './contracts.js';
import { createMemoryV3ScopeRoot, memoryV3ScopeRootId } from './v3-node-mapping.js';
import { writeMemoryV3MigrationLedger } from './v3-migration-ledger.js';
import { memoryV2NodeToAtomInput, orderedPublicMemoryV2Nodes } from './v3-migration-mapping.js';

export type MemoryV3MigrationBuildCheckpoint =
  | 'stage-initialized'
  | 'ledger-imported'
  | 'atom-written'
  | 'resources-imported';

export interface MemoryV3MigrationBuildOptions {
  dataDir: string;
  source: MemoryTreeDocument;
  policy: MemoryWritePolicy;
  v3?: MemoryRepositoryV3Options;
  onCheckpoint?: (
    checkpoint: MemoryV3MigrationBuildCheckpoint,
    context: { atomId?: string },
  ) => void | Promise<void>;
}

export async function buildMemoryV3Stage(options: MemoryV3MigrationBuildOptions): Promise<void> {
  await writeMemoryV3MigrationLedger(options.dataDir, {
    writeAudit: options.source.writeAudit,
    managementAudit: options.source.managementAudit,
    resourceManagementAudit: options.source.resourceManagementAudit,
    recoveryQueue: options.source.recoveryQueue,
    migrations: options.source.migrations,
    schemaMigrations: options.source.schemaMigrations,
  }, options.policy.maxAuditRecords);
  await options.onCheckpoint?.('ledger-imported', {});
  const backend = new MemoryRepositoryV3Backend({
    dataDir: options.dataDir,
    policy: options.policy,
    v3: options.v3,
  });
  try {
    await backend.initialize();
    await options.onCheckpoint?.('stage-initialized', {});

    const nodes = orderedPublicMemoryV2Nodes(options.source);
    const storageKeys = new Map<string, string | undefined>();
    for (const node of nodes) {
      const storageKey = await backend.ledger.storageScopeKey(node.scope, node.scopeKey);
      storageKeys.set(node.id, storageKey);
      await ensureScopeRoot(backend, node, storageKey);
    }
    for (const node of nodes) {
      const atom = await memoryV2NodeToAtomInput(backend, node, storageKeys.get(node.id));
      const created = await backend.atomStore.create(atom);
      backend.catalog.upsertAtom(created, requiredRelativePath(backend, created.id));
      await options.onCheckpoint?.('atom-written', { atomId: created.id });
    }

    for (const [group, resources] of groupResources(Object.values(options.source.resources))) {
      await backend.replaceResourceGroup(group, resources, {
        staleMode: 'remove',
        audit: false,
        preserveDisabled: true,
        reason: 'Imported from the verified Memory v2 snapshot.',
      });
    }
    await options.onCheckpoint?.('resources-imported', {});
  } finally {
    backend.close();
  }
}

async function ensureScopeRoot(
  backend: MemoryRepositoryV3Backend,
  node: MemoryNode,
  storageScopeKey: string | undefined,
): Promise<void> {
  const rootId = memoryV3ScopeRootId(node.branch, node.scope, storageScopeKey);
  if (await backend.atomStore.read(rootId)) return;
  const input = createMemoryV3ScopeRoot(node.branch, node.scope, storageScopeKey, node.createdAt);
  const root = await backend.atomStore.create(input);
  backend.catalog.upsertAtom(root, requiredRelativePath(backend, root.id));
}

function groupResources(resources: MemoryResourceRegistration[]): Map<string, MemoryResourceRegistration[]> {
  const groups = new Map<string, MemoryResourceRegistration[]>();
  for (const resource of resources) groups.set(resource.registryGroup, [...(groups.get(resource.registryGroup) ?? []), resource]);
  return groups;
}

function requiredRelativePath(backend: MemoryRepositoryV3Backend, atomId: string): string {
  const path = backend.atomStore.relativePathFor(atomId);
  if (!path) throw new Error(`Memory v3 atom has no staging path: ${atomId}`);
  return path;
}
