// Owns authoritative per-record entity/relation files and their rebuildable catalog projection.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogFn } from '../types.js';
import { MemoryCatalog } from './catalog.js';
import type { MemoryEntity, MemoryRelation } from './contracts.js';
import { canonicalJson, durableAtomicWriteJson } from './durable-json.js';

const MAX_GRAPH_RECORDS = 100_000;

export interface MemoryV3GraphStoreOptions {
  dataDir: string;
  catalog: MemoryCatalog;
  log?: LogFn;
}

export class MemoryV3GraphStore {
  readonly rootDir: string;
  private readonly catalog: MemoryCatalog;
  private readonly log?: LogFn;
  private readonly entities = new Map<string, MemoryEntity>();
  private readonly relations = new Map<string, MemoryRelation>();
  private initialized = false;
  private initialization?: Promise<void>;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3GraphStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'graph');
    this.catalog = options.catalog;
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.exclusive(() => this.initializeOnce()).catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    this.entities.clear();
    this.relations.clear();
    for (const path of await collectFiles(join(this.rootDir, 'entities'), '.entity.json')) {
      const entity = parseEntity(JSON.parse(await readFile(path, 'utf8')) as unknown, path);
      if (this.entities.has(entity.id)) throw new Error(`Duplicate Memory v3 entity id: ${entity.id}`);
      this.entities.set(entity.id, entity);
    }
    for (const entity of this.entities.values()) this.catalog.upsertEntity(entity);
    for (const path of await collectFiles(join(this.rootDir, 'relations'), '.relation.json')) {
      const relation = parseRelation(JSON.parse(await readFile(path, 'utf8')) as unknown, path);
      if (this.relations.has(relation.id)) throw new Error(`Duplicate Memory v3 relation id: ${relation.id}`);
      this.relations.set(relation.id, relation);
    }
    for (const relation of this.relations.values()) this.catalog.upsertRelation(relation);
    this.initialized = true;
  }

  async getEntity(id: string): Promise<MemoryEntity | undefined> {
    await this.ensureInitialized();
    const entity = this.entities.get(id);
    return entity ? structuredClone(entity) : undefined;
  }

  async upsertEntity(entity: MemoryEntity): Promise<MemoryEntity> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const verified = parseEntity(structuredClone(entity), entity.id);
      const existing = this.entities.get(verified.id);
      if (existing && canonicalJson(existing) === canonicalJson(verified)) return structuredClone(existing);
      await durableAtomicWriteJson(this.entityPath(verified.id), verified);
      try {
        this.catalog.upsertEntity(verified);
      } catch (error) {
        if (existing) await durableAtomicWriteJson(this.entityPath(existing.id), existing);
        else await unlink(this.entityPath(verified.id)).catch(() => undefined);
        throw error;
      }
      this.entities.set(verified.id, verified);
      return structuredClone(verified);
    });
  }

  async getRelation(id: string): Promise<MemoryRelation | undefined> {
    await this.ensureInitialized();
    const relation = this.relations.get(id);
    return relation ? structuredClone(relation) : undefined;
  }

  async listRelations(options: {
    status?: MemoryRelation['status'];
    limit?: number;
  } = {}): Promise<MemoryRelation[]> {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(MAX_GRAPH_RECORDS, Math.floor(options.limit ?? MAX_GRAPH_RECORDS)));
    return [...this.relations.values()]
      .filter((relation) => !options.status || relation.status === options.status)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((relation) => structuredClone(relation));
  }

  async upsertRelation(relation: MemoryRelation): Promise<MemoryRelation> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const verified = parseRelation(structuredClone(relation), relation.id);
      if (!this.entities.has(verified.fromEntityId) || !this.entities.has(verified.toEntityId)) {
        throw new Error('Memory relation endpoints must both exist in the authoritative graph store.');
      }
      const existing = this.relations.get(verified.id);
      if (existing && canonicalJson(existing) === canonicalJson(verified)) return structuredClone(existing);
      await durableAtomicWriteJson(this.relationPath(verified.id), verified);
      try {
        this.catalog.upsertRelation(verified);
      } catch (error) {
        if (existing) await durableAtomicWriteJson(this.relationPath(existing.id), existing);
        else await unlink(this.relationPath(verified.id)).catch(() => undefined);
        throw error;
      }
      this.relations.set(verified.id, verified);
      return structuredClone(verified);
    });
  }

  async purgeRelation(id: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const existing = this.relations.get(id);
      if (!existing) return false;
      const deleted = existing.status === 'deleted'
        ? existing
        : { ...existing, status: 'deleted' as const, revision: existing.revision + 1, updatedAt: new Date().toISOString() };
      if (deleted !== existing) {
        await durableAtomicWriteJson(this.relationPath(id), deleted);
        this.catalog.upsertRelation(deleted);
      }
      this.catalog.purgeRelation(id);
      await unlink(this.relationPath(id));
      this.relations.delete(id);
      return true;
    });
  }

  async purgeEntity(id: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const existing = this.entities.get(id);
      if (!existing) return false;
      const deleted = existing.status === 'deleted'
        ? existing
        : { ...existing, status: 'deleted' as const, revision: existing.revision + 1, updatedAt: new Date().toISOString() };
      if (deleted !== existing) {
        await durableAtomicWriteJson(this.entityPath(id), deleted);
        this.catalog.upsertEntity(deleted);
      }
      this.catalog.purgeEntity(id);
      await unlink(this.entityPath(id));
      this.entities.delete(id);
      return true;
    });
  }

  async countEntities(): Promise<number> {
    await this.ensureInitialized();
    return this.entities.size;
  }

  async countRelations(): Promise<number> {
    await this.ensureInitialized();
    return this.relations.size;
  }

  private entityPath(id: string): string {
    return recordPath(this.rootDir, 'entities', id, '.entity.json');
  }

  private relationPath(id: string): string {
    return recordPath(this.rootDir, 'relations', id, '.relation.json');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function recordPath(root: string, category: string, id: string, suffix: string): string {
  const hash = createHash('sha256').update(id, 'utf8').digest('hex');
  return join(root, category, hash.slice(0, 2), `${hash}${suffix}`);
}

async function collectFiles(root: string, suffix: string): Promise<string[]> {
  await mkdir(root, { recursive: true });
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
      if (files.length > MAX_GRAPH_RECORDS) throw new Error(`Memory v3 graph exceeds ${MAX_GRAPH_RECORDS} records.`);
    }
  }
  return files.sort();
}

function parseEntity(value: unknown, source: string): MemoryEntity {
  if (!value || typeof value !== 'object') throw new Error(`Invalid Memory v3 entity: ${source}`);
  const entity = value as Partial<MemoryEntity>;
  if (entity.version !== 1 || !entity.id || !entity.type || !entity.owner || !entity.scope
    || !entity.label || !Array.isArray(entity.aliases) || !entity.status
    || !Number.isInteger(entity.revision) || !entity.createdAt || !entity.updatedAt) {
    throw new Error(`Invalid Memory v3 entity: ${source}`);
  }
  return structuredClone(entity as MemoryEntity);
}

function parseRelation(value: unknown, source: string): MemoryRelation {
  if (!value || typeof value !== 'object') throw new Error(`Invalid Memory v3 relation: ${source}`);
  const relation = value as Partial<MemoryRelation>;
  if (relation.version !== 1 || !relation.id || !relation.fromEntityId || !relation.toEntityId
    || !relation.type || !relation.scope || !relation.source
    || (relation.sourceRefs !== undefined && !Array.isArray(relation.sourceRefs)) || !Array.isArray(relation.evidenceRefs)
    || !relation.status || !Number.isInteger(relation.revision) || !relation.createdAt || !relation.updatedAt) {
    throw new Error(`Invalid Memory v3 relation: ${source}`);
  }
  const sourceRefs = [...(relation.sourceRefs ?? [])];
  if (sourceRefs.some((sourceRef) => typeof sourceRef !== 'string' || !sourceRef.startsWith('conversation-source:'))) {
    throw new Error(`Memory v3 relation sourceRefs must reference conversation sources: ${source}`);
  }
  return { ...structuredClone(relation as MemoryRelation), sourceRefs };
}
