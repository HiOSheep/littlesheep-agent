// Owns memory-tree document versions, migration, atomic persistence, and serialized mutations.

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import { InjectionTier } from '../types.js';
import type {
  LogFn,
  MemoryBranchKind,
  MemoryNode,
  MemorySchemaMigrationRecord,
  MemoryTreeDocument,
  MemoryTreeDocumentV1,
} from '../types.js';

export const CURRENT_MEMORY_DOCUMENT_VERSION = 2;
export const MEMORY_RESOURCE_REGISTRY_VERSION = 1;
export const V1_TO_V2_MIGRATION_ID = 'memory-tree-schema-v1-to-v2';

export const MEMORY_BRANCH_ROOTS: Record<MemoryBranchKind, { summary: string; keys: string[] }> = {
  'long-term': {
    summary: 'Stable cross-project facts, user preferences and durable decisions.',
    keys: ['preference', 'decision', 'long-term', 'user'],
  },
  daily: {
    summary: 'Detailed chronological observations used for later recall and distillation.',
    keys: ['daily', 'timeline', 'recent', 'run'],
  },
  project: {
    summary: 'Workspace-scoped rules, architecture knowledge and project decisions.',
    keys: ['project', 'workspace', 'repository', 'rule'],
  },
  experience: {
    summary: 'Reusable methods, verified solutions, pitfalls and tool-use patterns.',
    keys: ['experience', 'method', 'pitfall', 'workflow'],
  },
};

export function memoryBranchRootId(branch: MemoryBranchKind): string {
  return `${branch}:root`;
}

function branchRoots(now: string): Record<string, MemoryNode> {
  return Object.fromEntries(
    (Object.keys(MEMORY_BRANCH_ROOTS) as MemoryBranchKind[]).map((branch) => {
      const spec = MEMORY_BRANCH_ROOTS[branch];
      const id = memoryBranchRootId(branch);
      return [id, {
        id,
        branch,
        childIds: [],
        scope: 'global',
        tier: InjectionTier.T1_ESSENTIAL,
        summary: spec.summary,
        content: '',
        retrievalKeys: spec.keys,
        importance: 1,
        confidence: 1,
        reason: 'Canonical memory-tree branch root.',
        sourceRunIds: [],
        sourceStages: ['migration'],
        status: 'active',
        createdAt: now,
        updatedAt: now,
        isBranchRoot: true,
      } satisfies MemoryNode];
    }),
  );
}

export function createMemoryTreeDocument(now = new Date().toISOString()): MemoryTreeDocument {
  return {
    version: CURRENT_MEMORY_DOCUMENT_VERSION,
    registryVersion: MEMORY_RESOURCE_REGISTRY_VERSION,
    updatedAt: now,
    nodes: branchRoots(now),
    resources: {},
    recoveryQueue: [],
    writeAudit: [],
    managementAudit: [],
    resourceManagementAudit: [],
    migrations: {},
    schemaMigrations: [],
  };
}

export function validateV1Document(value: unknown): MemoryTreeDocumentV1 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MemoryTreeDocumentV1>;
  if (candidate.version !== 1 || !candidate.nodes || typeof candidate.nodes !== 'object') return null;
  if (!Array.isArray(candidate.recoveryQueue) || !Array.isArray(candidate.writeAudit)) return null;
  if (!Array.isArray(candidate.managementAudit)) candidate.managementAudit = [];
  if (!candidate.migrations || typeof candidate.migrations !== 'object') candidate.migrations = {};
  return candidate as MemoryTreeDocumentV1;
}

export function validateV2Document(value: unknown): MemoryTreeDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MemoryTreeDocument>;
  if (candidate.version !== CURRENT_MEMORY_DOCUMENT_VERSION
    || candidate.registryVersion !== MEMORY_RESOURCE_REGISTRY_VERSION) return null;
  if (!candidate.nodes || typeof candidate.nodes !== 'object') return null;
  if (!candidate.resources || typeof candidate.resources !== 'object') candidate.resources = {};
  if (!Array.isArray(candidate.recoveryQueue) || !Array.isArray(candidate.writeAudit)) return null;
  if (!Array.isArray(candidate.managementAudit)) candidate.managementAudit = [];
  if (!Array.isArray(candidate.resourceManagementAudit)) candidate.resourceManagementAudit = [];
  if (!candidate.migrations || typeof candidate.migrations !== 'object') candidate.migrations = {};
  if (!Array.isArray(candidate.schemaMigrations)) candidate.schemaMigrations = [];
  return candidate as MemoryTreeDocument;
}

export function migrateV1Document(
  legacy: MemoryTreeDocumentV1,
  migration: MemorySchemaMigrationRecord,
): MemoryTreeDocument {
  return {
    version: CURRENT_MEMORY_DOCUMENT_VERSION,
    registryVersion: MEMORY_RESOURCE_REGISTRY_VERSION,
    updatedAt: legacy.updatedAt,
    nodes: structuredClone(legacy.nodes),
    resources: {},
    recoveryQueue: structuredClone(legacy.recoveryQueue),
    writeAudit: structuredClone(legacy.writeAudit),
    managementAudit: structuredClone(legacy.managementAudit),
    resourceManagementAudit: [],
    migrations: structuredClone(legacy.migrations),
    schemaMigrations: [migration],
  };
}

export interface MemoryDocumentStoreOptions {
  dataDir: string;
  log?: LogFn;
}

export interface MemoryDocumentMutation<T> {
  value: T;
  changed: boolean;
}

const writeChainsByPath = new Map<string, Promise<void>>();

export class MemoryDocumentStore {
  readonly rootDir: string;
  readonly indexPath: string;
  private readonly log?: LogFn;

  constructor(options: MemoryDocumentStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree');
    this.indexPath = join(this.rootDir, 'index.json');
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.exclusive(async () => {
      if (!existsSync(this.indexPath)) {
        await atomicWrite(this.indexPath, JSON.stringify(createMemoryTreeDocument(), null, 2));
        return;
      }
      let document = await this.readStoredDocument();
      let changed = false;
      const legacy = validateV1Document(document);
      if (legacy) {
        const startedAt = new Date().toISOString();
        const backupFile = `index.v1-${startedAt.replace(/[:.]/g, '-')}.backup.json`;
        await copyFile(this.indexPath, join(this.rootDir, backupFile));
        document = migrateV1Document(legacy, {
          id: V1_TO_V2_MIGRATION_ID,
          fromVersion: 1,
          toVersion: CURRENT_MEMORY_DOCUMENT_VERSION,
          startedAt,
          completedAt: new Date().toISOString(),
          backupFile,
        });
        changed = true;
        this.log?.('info', `memory-tree: migrated schema v1 -> v2; backup=${backupFile}`);
      }
      const current = validateV2Document(document);
      if (!current) throw this.unsupportedDocumentError(document, true);
      for (const [id, node] of Object.entries(branchRoots(current.updatedAt))) {
        if (!current.nodes[id]) {
          current.nodes[id] = node;
          changed = true;
        }
      }
      if (changed) await this.persist(current);
    });
  }

  read(): Promise<MemoryTreeDocument> {
    return this.readDocument();
  }

  async update<T>(operation: (document: MemoryTreeDocument) => MemoryDocumentMutation<T> | Promise<MemoryDocumentMutation<T>>): Promise<T> {
    return this.exclusive(async () => {
      const document = await this.readDocument();
      const mutation = await operation(document);
      if (mutation.changed) await this.persist(document);
      return mutation.value;
    });
  }

  async restoreSchemaBackup(backupFile: string): Promise<void> {
    const safeName = basename(backupFile);
    if (safeName !== backupFile || !/^index\.v1-.+\.backup\.json$/u.test(safeName)) {
      throw new Error('Invalid memory-tree schema backup name.');
    }
    await this.exclusive(async () => {
      const parsed = JSON.parse(await readFile(join(this.rootDir, safeName), 'utf8')) as unknown;
      if (!validateV1Document(parsed)) throw new Error('Memory-tree schema backup is not a valid v1 document.');
      await atomicWrite(this.indexPath, JSON.stringify(parsed, null, 2));
    });
  }

  private async readStoredDocument(): Promise<unknown> {
    if (!existsSync(this.indexPath)) return createMemoryTreeDocument();
    try {
      return JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown;
    } catch (error) {
      const backup = join(this.rootDir, `index.corrupt-${Date.now()}.json`);
      try {
        await copyFile(this.indexPath, backup);
      } catch {
        // The original read error remains the useful diagnostic.
      }
      this.log?.('warn', `memory-tree: corrupt index backed up; rebuilding roots: ${(error as Error).message}`);
      const rebuilt = createMemoryTreeDocument();
      await mkdir(this.rootDir, { recursive: true });
      await atomicWrite(this.indexPath, JSON.stringify(rebuilt, null, 2));
      return rebuilt;
    }
  }

  private async readDocument(): Promise<MemoryTreeDocument> {
    const parsed = await this.readStoredDocument();
    const current = validateV2Document(parsed);
    if (current) return current;
    const legacy = validateV1Document(parsed);
    if (legacy) {
      const now = new Date().toISOString();
      this.log?.('warn', 'memory-tree: reading a v1 document through compatibility mapping; call initialize() to persist v2.');
      return migrateV1Document(legacy, {
        id: V1_TO_V2_MIGRATION_ID,
        fromVersion: 1,
        toVersion: CURRENT_MEMORY_DOCUMENT_VERSION,
        startedAt: now,
        completedAt: now,
        backupFile: '',
      });
    }
    throw this.unsupportedDocumentError(parsed, false);
  }

  private unsupportedDocumentError(document: unknown, initializing: boolean): Error {
    const version = document && typeof document === 'object' && 'version' in document
      ? Number((document as { version?: unknown }).version)
      : undefined;
    if (Number.isFinite(version)) {
      return new Error(initializing
        ? `memory-tree: unsupported document version ${version}; current runtime supports ${CURRENT_MEMORY_DOCUMENT_VERSION}`
        : `memory-tree: unsupported document version ${version}; refusing to rebuild or overwrite it`);
    }
    return new Error('memory-tree: unsupported document shape');
  }

  private async persist(document: MemoryTreeDocument): Promise<void> {
    document.updatedAt = new Date().toISOString();
    await mkdir(this.rootDir, { recursive: true });
    await atomicWrite(this.indexPath, JSON.stringify(document, null, 2));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeChainsByPath.get(this.indexPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    writeChainsByPath.set(this.indexPath, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (writeChainsByPath.get(this.indexPath) === current) {
        writeChainsByPath.delete(this.indexPath);
      }
    }
  }
}
