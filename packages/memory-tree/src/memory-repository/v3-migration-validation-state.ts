// Validates an already initialized Memory v3 backend against its migration source.

import type { MemoryNode, MemoryTreeDocument } from '../types.js';
import type { MemoryAtom } from '../v3/contracts.js';
import { canonicalJson, sha256Canonical } from '../v3/durable-json.js';
import type { MemoryRepositoryV3Backend } from './v3-backend.js';
import type { MemoryV3MigrationValidation } from './v3-migration-contracts.js';
import { classifyMemoryWriteIntent } from './v3-statement.js';
import { legacySourceEvidence } from './v3-node-mapping.js';
import { memoryV2NodeAsIntent, publicMemoryV2Nodes } from './v3-migration-mapping.js';
import { unique } from './text.js';
import { MemoryConversationSourceStore } from '../conversation-source-store.js';

export async function validateMemoryV3RepositoryState(
  backend: MemoryRepositoryV3Backend,
  source: MemoryTreeDocument,
  sourceManifestHash: string,
): Promise<MemoryV3MigrationValidation> {
  const scan = await backend.atomStore.scan({ quarantine: false });
  if (scan.issues.length > 0) throw new Error(`Memory v3 scan found ${scan.issues.length} invalid atom(s).`);
  const target = await backend.snapshot();
  assertDocumentEquivalent(source, target);
  for (const node of publicMemoryV2Nodes(source)) {
    const atom = await backend.atomStore.read(node.id);
    if (!atom) throw new Error(`Memory v3 is missing atom ${node.id}.`);
    assertAtomEquivalent(node, atom);
    for (const entityId of atom.entityRefs) {
      if (!await backend.graphStore.getEntity(entityId)) {
        throw new Error(`Memory v3 atom ${node.id} has a missing entity reference: ${entityId}`);
      }
    }
    for (const relationId of atom.relationRefs) {
      if (!await backend.graphStore.getRelation(relationId)) {
        throw new Error(`Memory v3 atom ${node.id} has a missing relation reference: ${relationId}`);
      }
    }
  }
  const catalogIntegrity = backend.catalog.integrityCheck();
  if (catalogIntegrity !== 'ok') throw new Error(`Memory v3 catalog integrity check failed: ${catalogIntegrity}`);
  const atomCount = await backend.atomStore.count();
  if (backend.catalog.countAtoms() !== atomCount) throw new Error('Memory v3 catalog and atom store counts differ.');
  const catalogEntries = backend.catalog.listAtoms({ limit: 100_000 });
  const conversationSources = await new MemoryConversationSourceStore({ dataDir: backend.dataDir }).manifest();
  const validationHash = sha256Canonical({
    sourceManifestHash,
    conversationSources,
    nodes: catalogEntries.map((entry) => [entry.atomId, entry.contentHash]),
    resources: Object.keys(target.resources).sort(),
    writeAuditIds: target.writeAudit.map((record) => record.id).sort(),
    managementAuditIds: target.managementAudit.map((record) => record.id).sort(),
    resourceAuditIds: target.resourceManagementAudit.map((record) => record.id).sort(),
    recoveryIds: target.recoveryQueue.map((record) => record.id).sort(),
    catalogIntegrity,
  });
  return {
    validationHash,
    nodeCount: publicMemoryV2Nodes(source).length,
    resourceCount: Object.keys(source.resources).length,
    atomCount,
    pendingEmbeddingCount: catalogEntries.filter((entry) => entry.embeddingStatus === 'pending').length,
    catalogIntegrity,
  };
}

function assertDocumentEquivalent(source: MemoryTreeDocument, target: MemoryTreeDocument): void {
  const sourceNodes = Object.fromEntries(Object.entries(source.nodes).map(([id, node]) => [id, comparableNode(node)]));
  const targetNodes = Object.fromEntries(Object.entries(target.nodes).map(([id, node]) => [id, comparableNode(node)]));
  if (canonicalJson(sourceNodes) !== canonicalJson(targetNodes)) throw new Error('Memory v3 node projection differs from Memory v2.');
  if (canonicalJson(source.resources) !== canonicalJson(target.resources)) throw new Error('Memory v3 resources differ from Memory v2.');
  if (canonicalJson(sortedRecords(source.writeAudit)) !== canonicalJson(sortedRecords(target.writeAudit))) throw new Error('Memory v3 write audit differs from Memory v2.');
  if (canonicalJson(sortedRecords(source.managementAudit)) !== canonicalJson(sortedRecords(target.managementAudit))) throw new Error('Memory v3 management audit differs from Memory v2.');
  if (canonicalJson(sortedRecords(source.resourceManagementAudit)) !== canonicalJson(sortedRecords(target.resourceManagementAudit))) throw new Error('Memory v3 resource audit differs from Memory v2.');
  if (canonicalJson(sortedRecords(source.recoveryQueue)) !== canonicalJson(sortedRecords(target.recoveryQueue))) throw new Error('Memory v3 recovery queue differs from Memory v2.');
  if (canonicalJson(source.migrations) !== canonicalJson(target.migrations)) throw new Error('Memory v3 migration records differ from Memory v2.');
  if (canonicalJson(sortedRecords(source.schemaMigrations)) !== canonicalJson(sortedRecords(target.schemaMigrations))) throw new Error('Memory v3 schema migration records differ from Memory v2.');
}

function assertAtomEquivalent(node: MemoryNode, atom: MemoryAtom): void {
  const classification = classifyMemoryWriteIntent(memoryV2NodeAsIntent(node));
  const expected = {
    id: node.id,
    domain: classification.domain,
    statementKind: classification.statementKind,
    epistemicStatus: classification.epistemicStatus,
    authorityScope: classification.authorityScope,
    assertedBy: classification.assertedBy,
    resolutionStatus: classification.resolutionStatus,
    summary: node.summary,
    content: node.content,
    sourceRunIds: node.sourceRunIds,
    sourceStages: node.sourceStages,
    sourceRefs: [],
    evidenceRefs: unique((node.sourceRefs ?? []).map(legacySourceEvidence)),
    mergedIntentIds: unique(node.mergedFrom ?? []),
    status: node.status === 'deleted' ? 'tombstone' : node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, atom[key as keyof MemoryAtom]]));
  if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error(`Memory v3 atom differs from Memory v2 node ${node.id}.`);
}

function comparableNode(node: MemoryNode) {
  if (node.isBranchRoot) {
    return {
      id: node.id,
      branch: node.branch,
      childIds: [...node.childIds].sort(),
      scope: node.scope,
      tier: node.tier,
      status: node.status,
      isBranchRoot: true,
    };
  }
  const {
    atomRevision: _atomRevision,
    invalidatedAt: _invalidatedAt,
    mergedIntoId: _mergedIntoId,
    evidenceRefs: _evidenceRefs,
    domain: _domain,
    statementKind: _statementKind,
    epistemicStatus: _epistemicStatus,
    authorityScope: _authorityScope,
    assertedBy: _assertedBy,
    entityRefs: _entityRefs,
    relationRefs: _relationRefs,
    ...v2Projection
  } = node;
  return {
    ...v2Projection,
    childIds: [...node.childIds].sort(),
    sourceRefs: node.sourceRefs ?? [],
    mergedFrom: node.mergedFrom ?? [],
  };
}

function sortedRecords<T extends { id: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}
