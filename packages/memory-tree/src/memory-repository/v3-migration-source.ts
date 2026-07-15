// Reads and snapshots Memory v2 without invoking its self-healing document store.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { MemoryNode, MemoryTreeDocument } from '../types.js';
import { durableAtomicWriteJson, sha256Canonical } from '../v3/durable-json.js';
import { MEMORY_REPOSITORY_LOCATOR_FILE } from './repository-locator.js';
import { validateV2Document } from './document-store.js';
import { normalizeMemoryResource, validateMemoryResourceRegistry } from './resource-store.js';

const MAX_V2_SNAPSHOT_FILES = 20_000;

export interface MemoryV2SnapshotFile {
  relativePath: string;
  size: number;
  hash: string;
}

export interface MemoryV2SnapshotManifest {
  version: 1;
  files: MemoryV2SnapshotFile[];
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
}

export interface InspectedMemoryV2Source {
  rootDir: string;
  indexPath: string;
  indexHash: string;
  manifest: MemoryV2SnapshotManifest;
  document: MemoryTreeDocument;
}

export async function inspectMemoryV2Source(dataDir: string): Promise<InspectedMemoryV2Source> {
  const rootDir = join(dataDir, 'memory-tree');
  const files = await collectFiles(rootDir, true);
  const index = files.find((file) => file.relativePath === 'index.json');
  if (!index) throw new Error('Memory v2 index.json is missing; refusing to synthesize migration input.');
  const raw = await readFile(join(rootDir, index.relativePath), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Memory v2 index.json is corrupt: ${errorMessage(error)}`);
  }
  return {
    rootDir,
    indexPath: join(rootDir, index.relativePath),
    indexHash: index.hash,
    manifest: buildManifest(files),
    document: validateMemoryV2SourceDocument(parsed),
  };
}

export async function writeMemoryV2Snapshot(
  source: InspectedMemoryV2Source,
  snapshotDir: string,
): Promise<MemoryV2SnapshotManifest> {
  const contentDir = join(snapshotDir, 'v2');
  for (const file of source.manifest.files) {
    const target = join(contentDir, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source.rootDir, file.relativePath), target);
  }
  const copied = buildManifest(await collectFiles(contentDir, false));
  assertSameManifest(source.manifest, copied, 'Memory v2 snapshot does not match its source.');
  const current = await inspectMemoryV2Source(dirname(source.rootDir));
  assertSameManifest(source.manifest, current.manifest, 'Memory v2 changed while its snapshot was being created.');
  await durableAtomicWriteJson(join(snapshotDir, 'manifest.json'), copied);
  return copied;
}

export async function loadMemoryV2Snapshot(snapshotDir: string): Promise<InspectedMemoryV2Source> {
  const contentDir = join(snapshotDir, 'v2');
  const manifest = parseManifest(JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as unknown);
  const actual = buildManifest(await collectFiles(contentDir, false));
  assertSameManifest(manifest, actual, 'Stored Memory v2 snapshot failed manifest verification.');
  const index = actual.files.find((file) => file.relativePath === 'index.json');
  if (!index) throw new Error('Stored Memory v2 snapshot has no index.json.');
  const raw = await readFile(join(contentDir, 'index.json'), 'utf8');
  return {
    rootDir: contentDir,
    indexPath: join(contentDir, 'index.json'),
    indexHash: index.hash,
    manifest: actual,
    document: validateMemoryV2SourceDocument(JSON.parse(raw) as unknown),
  };
}

export function assertSameManifest(
  expected: MemoryV2SnapshotManifest,
  actual: MemoryV2SnapshotManifest,
  message: string,
): void {
  if (expected.manifestHash !== actual.manifestHash
    || expected.fileCount !== actual.fileCount
    || expected.totalBytes !== actual.totalBytes) {
    throw new Error(message);
  }
}

export function validateMemoryV2SourceDocument(value: unknown): MemoryTreeDocument {
  const document = validateV2Document(structuredClone(value));
  if (!document) throw new Error('Memory migration requires a valid Memory v2 document.');
  const nodeIds = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    assertMemoryNode(node);
    if (nodeIds.has(node.id)) throw new Error(`Memory v2 contains duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  for (const [key, node] of Object.entries(document.nodes)) {
    if (key !== node.id) throw new Error(`Memory v2 node map key does not match node.id: ${key} != ${node.id}`);
  }

  for (const branch of ['long-term', 'daily', 'project', 'experience'] as const) {
    const id = `${branch}:root`;
    const root = document.nodes[id];
    if (!root || !root.isBranchRoot || root.branch !== branch || root.parentNodeId) {
      throw new Error(`Memory v2 canonical branch root is invalid or missing: ${id}`);
    }
  }
  validateHierarchy(document.nodes);

  const resourceIds = new Set<string>();
  for (const [key, resource] of Object.entries(document.resources)) {
    const normalized = normalizeMemoryResource(resource);
    if (key !== normalized.id) throw new Error(`Memory v2 resource map key does not match resource.id: ${key}`);
    if (resourceIds.has(normalized.id)) throw new Error(`Memory v2 contains duplicate resource id: ${normalized.id}`);
    resourceIds.add(normalized.id);
    document.resources[key] = normalized;
  }
  validateMemoryResourceRegistry(document.resources);
  assertRecordIds(document.writeAudit, 'write audit');
  assertRecordIds(document.managementAudit, 'management audit');
  assertRecordIds(document.resourceManagementAudit, 'resource audit');
  assertRecordIds(document.recoveryQueue, 'recovery record');
  assertRecordIds(Object.values(document.migrations), 'migration record');
  assertRecordIds(document.schemaMigrations, 'schema migration');
  for (const [key, migration] of Object.entries(document.migrations)) {
    if (key !== migration.id) throw new Error(`Memory v2 migration map key does not match id: ${key}`);
  }
  return document;
}

function validateHierarchy(nodes: Record<string, MemoryNode>): void {
  for (const node of Object.values(nodes)) {
    const childIds = new Set(node.childIds);
    if (childIds.size !== node.childIds.length) throw new Error(`Memory v2 node has duplicate child ids: ${node.id}`);
    for (const childId of node.childIds) {
      const child = nodes[childId];
      if (!child) throw new Error(`Memory v2 node ${node.id} references missing child ${childId}.`);
      if (child.parentNodeId !== node.id) throw new Error(`Memory v2 child ${childId} has an inconsistent parent.`);
    }
    if (node.isBranchRoot) continue;
    const parent = node.parentNodeId ? nodes[node.parentNodeId] : undefined;
    if (!parent) throw new Error(`Memory v2 node ${node.id} has an orphan parent.`);
    if (parent.branch !== node.branch) throw new Error(`Memory v2 node ${node.id} crosses branch boundaries.`);
    if (!parent.childIds.includes(node.id)) throw new Error(`Memory v2 parent ${parent.id} omits child ${node.id}.`);
    if (!parent.isBranchRoot && (parent.scope !== node.scope || parent.scopeKey !== node.scopeKey)) {
      throw new Error(`Memory v2 node ${node.id} crosses scope boundaries below a branch root.`);
    }
    const visited = new Set([node.id]);
    let cursor: MemoryNode | undefined = parent;
    while (cursor) {
      if (visited.has(cursor.id)) throw new Error(`Memory v2 hierarchy contains a cycle at ${cursor.id}.`);
      visited.add(cursor.id);
      cursor = cursor.parentNodeId ? nodes[cursor.parentNodeId] : undefined;
    }
  }
}

function assertMemoryNode(node: MemoryNode): void {
  const validBranch = ['long-term', 'daily', 'project', 'experience'].includes(node.branch);
  const validScope = ['global', 'workspace', 'project', 'session'].includes(node.scope);
  if (!node || typeof node.id !== 'string' || !node.id || !validBranch || !validScope
    || !Array.isArray(node.childIds) || !node.childIds.every((id) => typeof id === 'string' && id.length > 0)
    || ![0, 1, 2, 3].includes(node.tier) || typeof node.summary !== 'string' || !node.summary
    || typeof node.content !== 'string' || !Array.isArray(node.retrievalKeys)
    || typeof node.importance !== 'number' || typeof node.confidence !== 'number'
    || typeof node.reason !== 'string' || !node.reason || !Array.isArray(node.sourceRunIds)
    || !Array.isArray(node.sourceStages) || !['active', 'archived', 'deleted'].includes(node.status)
    || !Number.isFinite(Date.parse(node.createdAt)) || !Number.isFinite(Date.parse(node.updatedAt))) {
    throw new Error(`Memory v2 contains an invalid node: ${node?.id ?? '<unknown>'}`);
  }
  if (node.scope !== 'global' && !node.scopeKey) throw new Error(`Memory v2 node ${node.id} requires scopeKey.`);
}

function assertRecordIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!value || typeof value.id !== 'string' || !value.id) throw new Error(`Memory v2 contains an invalid ${label}.`);
    if (ids.has(value.id)) throw new Error(`Memory v2 contains duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
}

async function collectFiles(root: string, excludeMigrationArtifacts: boolean): Promise<MemoryV2SnapshotFile[]> {
  const pending = [root];
  const files: MemoryV2SnapshotFile[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).replace(/\\/gu, '/');
      if (excludeMigrationArtifacts && excludedSourcePath(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Memory v2 snapshot refuses symbolic link: ${relativePath}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        files.push({ relativePath, size: info.size, hash: await hashFile(path) });
      }
      if (files.length > MAX_V2_SNAPSHOT_FILES) {
        throw new Error(`Memory v2 snapshot exceeds the ${MAX_V2_SNAPSHOT_FILES} file safety limit.`);
      }
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function excludedSourcePath(path: string): boolean {
  const first = path.split('/')[0];
  return first === 'v3' || first === 'migrations' || path === MEMORY_REPOSITORY_LOCATOR_FILE;
}

function buildManifest(files: MemoryV2SnapshotFile[]): MemoryV2SnapshotManifest {
  const normalized = files.map((file) => ({ ...file }));
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);
  return {
    version: 1,
    files: normalized,
    fileCount: normalized.length,
    totalBytes,
    manifestHash: sha256Canonical(normalized),
  };
}

function parseManifest(value: unknown): MemoryV2SnapshotManifest {
  if (!value || typeof value !== 'object') throw new Error('Memory v2 snapshot manifest is invalid.');
  const manifest = value as Partial<MemoryV2SnapshotManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Memory v2 snapshot manifest is invalid.');
  const rebuilt = buildManifest(manifest.files as MemoryV2SnapshotFile[]);
  if (rebuilt.manifestHash !== manifest.manifestHash || rebuilt.fileCount !== manifest.fileCount
    || rebuilt.totalBytes !== manifest.totalBytes) throw new Error('Memory v2 snapshot manifest hash is invalid.');
  return rebuilt;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
