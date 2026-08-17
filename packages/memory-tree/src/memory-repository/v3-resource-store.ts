// Owns per-resource Memory v3 metadata files, lifecycle transactions, and stable entity projection.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LogFn,
  MemoryResourceManagementAction,
  MemoryResourceManagementAuditRecord,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryResourceRebindPatch,
  MemoryWritePolicy,
} from '../types.js';
import { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryEntity, MemoryEntityType } from '../v3/contracts.js';
import { durableAtomicWriteJson } from '../v3/durable-json.js';
import { MemoryV3GraphStore } from '../v3/graph-store.js';
import type {
  ManageMemoryResourceOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './contracts.js';
import { normalizedFilePath, rebaseFilePath, sameFilePath } from './path-utils.js';
import {
  createMemoryResourceAudit,
  matchesMemoryResourceQuery,
  memoryResourceSourceIdentity,
  normalizeMemoryResource,
  sameResourceRegistration,
  validateMemoryResourceRegistry,
} from './resource-store.js';
import { cleanText } from './text.js';
import { MemoryV3RepositoryLedger, type MemoryV3RepositoryTransaction } from './v3-ledger.js';
import { memoryV3EntityId } from './v3-node-mapping.js';

const MAX_RESOURCE_FILES = 50_000;

export interface MemoryV3ResourceStoreOptions {
  dataDir: string;
  catalog: MemoryCatalog;
  graphStore: MemoryV3GraphStore;
  ledger: MemoryV3RepositoryLedger;
  policy: MemoryWritePolicy;
  log?: LogFn;
}

interface ResourceMutationPayload {
  upserts: MemoryResourceRegistration[];
  removals: string[];
  audits: MemoryResourceManagementAuditRecord[];
}

export class MemoryV3ResourceStore {
  readonly rootDir: string;
  private readonly catalog: MemoryCatalog;
  private readonly graphStore: MemoryV3GraphStore;
  private readonly ledger: MemoryV3RepositoryLedger;
  private readonly log?: LogFn;
  private readonly resources = new Map<string, MemoryResourceRegistration>();
  private initialized = false;
  private initialization?: Promise<void>;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3ResourceStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'resources');
    this.catalog = options.catalog;
    this.graphStore = options.graphStore;
    this.ledger = options.ledger;
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.initializeOnce().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    this.resources.clear();
    for (const path of await collectResourceFiles(this.rootDir)) {
      try {
        const resource = normalizeMemoryResource(JSON.parse(await readFile(path, 'utf8')) as MemoryResourceRegistration);
        if (this.resources.has(resource.id)) throw new Error(`duplicate resource id ${resource.id}`);
        this.resources.set(resource.id, resource);
      } catch (error) {
        this.log?.('warn', `memory-v3: ignored invalid resource ${path}: ${errorMessage(error)}`);
      }
    }
    validateMemoryResourceRegistry(Object.fromEntries(this.resources));
    for (const resource of this.resources.values()) await this.upsertResourceEntity(resource);
    await this.recoverTransactions();
    this.initialized = true;
  }

  async get(id: string): Promise<MemoryResourceRegistration | undefined> {
    await this.ensureInitialized();
    const resource = this.resources.get(id);
    return resource ? structuredClone(resource) : undefined;
  }

  async list(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    await this.ensureInitialized();
    return [...this.resources.values()]
      .filter((resource) => matchesMemoryResourceQuery(resource, query))
      .sort((left, right) => left.tier - right.tier || left.title.localeCompare(right.title))
      .map((resource) => structuredClone(resource));
  }

  listAudit(resourceId?: string, limit = 100): Promise<MemoryResourceManagementAuditRecord[]> {
    return this.ledger.listResourceAudits(resourceId, limit);
  }

  replaceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options: ReplaceMemoryResourceGroupOptions = {},
  ): Promise<MemoryResourceRegistration[]> {
    return this.mutate(async () => {
      const normalizedGroup = cleanText(registryGroup);
      if (!normalizedGroup) throw new Error('必须提供记忆资源注册组。');
      const next = cloneResources(this.resources);
      const now = new Date().toISOString();
      const audits: MemoryResourceManagementAuditRecord[] = [];
      const incoming = resources.map((resource) => normalizeMemoryResource({ ...resource, registryGroup: normalizedGroup }));
      const incomingIds = new Set(incoming.map((resource) => resource.id));
      if (incomingIds.size !== incoming.length) {
        throw new Error(`记忆资源注册组 "${normalizedGroup}" 包含重复的资源 ID。`);
      }

      for (const existing of next.values()) {
        if (existing.registryGroup !== normalizedGroup || incomingIds.has(existing.id)) continue;
        if (options.staleMode === 'remove') {
          if (options.audit !== false && existing.scope !== 'run') {
            audits.push(createMemoryResourceAudit(existing, 'remove', {
              actor: 'system',
              reason: options.reason ?? `资源已不再出现在注册组 "${normalizedGroup}" 中。`,
            }));
          }
          next.delete(existing.id);
          continue;
        }
        if (existing.status === 'missing' || existing.status === 'disabled') continue;
        if (options.audit !== false && existing.scope !== 'run') {
          audits.push(createMemoryResourceAudit(existing, 'mark-missing', {
            actor: 'system',
            reason: options.reason ?? `资源已不再出现在注册组 "${normalizedGroup}" 中。`,
            toStatus: 'missing',
          }));
        }
        next.set(existing.id, { ...existing, status: 'missing', updatedAt: now });
      }

      for (const resource of incoming) {
        const existing = next.get(resource.id);
        const candidate: MemoryResourceRegistration = {
          ...resource,
          registeredAt: existing?.registeredAt ?? resource.registeredAt,
          status: options.preserveDisabled !== false && existing?.status === 'disabled'
            ? 'disabled'
            : resource.status,
        };
        if (existing && memoryResourceSourceIdentity(existing) !== memoryResourceSourceIdentity(candidate)) {
          throw new Error(`记忆资源 "${resource.id}" 的来源身份已改变；请使用 rebindResource()，以便记录迁移审计。`);
        }
        if (existing && sameResourceRegistration(existing, candidate)) continue;
        if (existing && existing.status !== candidate.status && options.audit !== false && existing.scope !== 'run') {
          const action = candidate.status === 'active'
            ? 'restore'
            : candidate.status === 'missing'
              ? 'mark-missing'
              : candidate.status === 'conflict'
                ? 'mark-conflict'
                : 'disable';
          audits.push(createMemoryResourceAudit(existing, action, {
            actor: 'system',
            reason: options.reason ?? `注册组 "${normalizedGroup}" 已同步资源状态。`,
            toStatus: candidate.status,
          }));
        }
        next.set(candidate.id, candidate);
      }
      validateMemoryResourceRegistry(Object.fromEntries(next));
      await this.commitMutation(next, audits);
      return incoming.map((resource) => structuredClone(this.resources.get(resource.id)!));
    });
  }

  manage(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options: ManageMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.mutate(async () => {
      const resource = this.resources.get(resourceId);
      if (!resource) return undefined;
      const next = cloneResources(this.resources);
      const actor = options.actor ?? 'user';
      const reason = options.reason ?? ({
        disable: '记忆资源已被停用。',
        restore: '记忆资源已恢复。',
        'mark-missing': '记忆资源来源已标记为缺失。',
        'mark-conflict': '记忆资源来源已标记为冲突。',
        remove: '记忆资源登记已移除。',
      } satisfies Record<Exclude<MemoryResourceManagementAction, 'rebind'>, string>)[action];

      if (action === 'remove') {
        if (resource.status === 'active' && options.allowActiveRemoval !== true) {
          throw new Error('请先停用活动资源，再移除其登记。');
        }
        next.delete(resourceId);
        const audit = options.audit === false ? undefined : createMemoryResourceAudit(resource, action, { actor, reason });
        await this.commitMutation(next, audit ? [audit] : []);
        return { changed: true, removed: true, audit };
      }

      let toStatus = resource.status;
      if (action === 'disable') toStatus = 'disabled';
      else if (action === 'restore') toStatus = options.restoreStatus ?? 'active';
      else if (action === 'mark-missing' && resource.status !== 'disabled') toStatus = 'missing';
      else if (action === 'mark-conflict' && resource.status !== 'disabled') toStatus = 'conflict';
      if (toStatus === resource.status) return { resource: structuredClone(resource), changed: false, removed: false };

      const updated = { ...resource, status: toStatus, updatedAt: new Date().toISOString() };
      next.set(resourceId, updated);
      validateMemoryResourceRegistry(Object.fromEntries(next));
      const audit = options.audit === false ? undefined : createMemoryResourceAudit(resource, action, {
        actor, reason, fromStatus: resource.status, toStatus,
      });
      await this.commitMutation(next, audit ? [audit] : []);
      return { resource: structuredClone(updated), changed: true, removed: false, audit };
    });
  }

  rebind(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options: RebindMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.mutate(async () => {
      const resource = this.resources.get(resourceId);
      if (!resource) return undefined;
      if (resource.source.kind !== 'file') throw new Error('只有文件来源的记忆资源可以重新绑定。');
      const fromSourcePath = resource.source.path;
      const targetPath = normalizedFilePath(patch.sourcePath);
      if (fromSourcePath && sameFilePath(fromSourcePath, targetPath)
        && patch.scopeKey === undefined && patch.title === undefined && patch.kind === undefined
        && patch.indexKeys === undefined && patch.contentHash === undefined && patch.status === undefined) {
        return { resource: structuredClone(resource), changed: false, removed: false };
      }
      const next = cloneResources(this.resources);
      const updated = normalizeMemoryResource({
        ...resource,
        title: patch.title ?? resource.title,
        kind: patch.kind ?? resource.kind,
        scopeKey: patch.scopeKey ?? resource.scopeKey,
        indexKeys: patch.indexKeys ?? resource.indexKeys,
        source: { ...resource.source, path: targetPath, contentHash: patch.contentHash ?? resource.source.contentHash },
        status: resource.status === 'disabled' ? 'disabled' : patch.status ?? 'active',
        updatedAt: new Date().toISOString(),
      });
      const conflicting = [...next.values()].find((candidate) => (
        candidate.id !== resourceId && candidate.status === 'active' && candidate.authority === 'authoritative'
        && memoryResourceSourceIdentity(candidate) === memoryResourceSourceIdentity(updated)
      ));
      const audits: MemoryResourceManagementAuditRecord[] = [];
      if (conflicting) {
        const replaceable = options.replaceConflictingResource === true
          && conflicting.registryGroup === resource.registryGroup
          && conflicting.scope === resource.scope
          && conflicting.scopeKey === resource.scopeKey;
        if (!replaceable) throw new Error(`权威记忆资源 "${conflicting.id}" 已引用目标来源，无法直接重新绑定。`);
        audits.push(createMemoryResourceAudit(conflicting, 'remove', {
          actor: options.actor ?? 'user',
          reason: `重新定位时，已将自动发现的替代登记合并到稳定资源 "${resourceId}"。`,
        }));
        next.delete(conflicting.id);
      }
      next.set(resourceId, updated);
      validateMemoryResourceRegistry(Object.fromEntries(next));
      const audit = createMemoryResourceAudit(resource, 'rebind', {
        actor: options.actor ?? 'user',
        reason: options.reason ?? '记忆资源来源已重新定位。',
        toStatus: updated.status,
        fromSourcePath,
        toSourcePath: targetPath,
      });
      audits.push(audit);
      await this.commitMutation(next, audits);
      return { resource: structuredClone(updated), changed: true, removed: false, audit };
    });
  }

  remove(query: MemoryResourceQuery, options: RemoveMemoryResourcesOptions = {}): Promise<number> {
    return this.mutate(async () => {
      const next = cloneResources(this.resources);
      const audits: MemoryResourceManagementAuditRecord[] = [];
      let removed = 0;
      for (const resource of this.resources.values()) {
        if (!matchesMemoryResourceQuery(resource, query)) continue;
        if (resource.status === 'active' && options.includeActive !== true) continue;
        if (options.audit !== false && resource.scope !== 'run') {
          audits.push(createMemoryResourceAudit(resource, 'remove', {
            actor: options.actor ?? 'system',
            reason: options.reason ?? '记忆资源登记已清理。',
          }));
        }
        next.delete(resource.id);
        removed += 1;
      }
      if (removed > 0) await this.commitMutation(next, audits);
      return removed;
    });
  }

  rebindProjectPath(fromPath: string, toPath: string): Promise<number> {
    return this.mutate(async () => {
      const from = normalizedFilePath(fromPath);
      const to = normalizedFilePath(toPath);
      if (sameFilePath(from, to)) return 0;
      const next = cloneResources(this.resources);
      const audits: MemoryResourceManagementAuditRecord[] = [];
      let count = 0;
      for (const resource of this.resources.values()) {
        if (resource.branch !== 'project' || !resource.scopeKey || !sameFilePath(resource.scopeKey, from)) continue;
        const updated: MemoryResourceRegistration = {
          ...resource,
          scopeKey: to,
          source: {
            ...resource.source,
            path: resource.source.path ? rebaseFilePath(resource.source.path, from, to) : undefined,
          },
          updatedAt: new Date().toISOString(),
        };
        next.set(resource.id, updated);
        audits.push(createMemoryResourceAudit(resource, 'rebind', {
          actor: 'system',
          reason: '项目路径已重新绑定，并保留资源身份。',
          toStatus: updated.status,
          fromSourcePath: resource.source.path,
          toSourcePath: updated.source.path,
        }));
        count += 1;
      }
      if (count > 0) {
        validateMemoryResourceRegistry(Object.fromEntries(next));
        await this.commitMutation(next, audits);
      }
      return count;
    });
  }

  async snapshotResources(): Promise<Record<string, MemoryResourceRegistration>> {
    await this.ensureInitialized();
    return Object.fromEntries([...this.resources.entries()].map(([id, resource]) => [id, structuredClone(resource)]));
  }

  private async commitMutation(
    next: Map<string, MemoryResourceRegistration>,
    audits: MemoryResourceManagementAuditRecord[],
  ): Promise<void> {
    const upserts = [...next.values()].filter((resource) => {
      const existing = this.resources.get(resource.id);
      return !existing || !sameResourceRegistration(existing, resource);
    });
    const removals = [...this.resources.keys()].filter((id) => !next.has(id));
    if (upserts.length === 0 && removals.length === 0 && audits.length === 0) return;
    const transaction = await this.ledger.captureTransaction(
      `resource-mutation:${randomUUID()}`,
      'resource-mutation',
      { upserts, removals, audits },
    );
    try {
      await this.applyTransaction(transaction);
      await this.ledger.commitTransaction(transaction.id);
    } catch (error) {
      await this.ledger.markTransactionRecovery(transaction.id, errorMessage(error));
      throw error;
    }
  }

  private async applyTransaction(transaction: MemoryV3RepositoryTransaction): Promise<void> {
    const payload = parseResourceMutationPayload(transaction.payload);
    const next = cloneResources(this.resources);
    for (const id of payload.removals) next.delete(id);
    for (const resource of payload.upserts) next.set(resource.id, resource);
    validateMemoryResourceRegistry(Object.fromEntries(next));
    this.assertEntityRemovalsAllowed(this.resources, next);

    for (const resource of payload.upserts) await durableAtomicWriteJson(this.pathFor(resource.id), resource);
    for (const id of payload.removals) {
      await unlink(this.pathFor(id)).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
    await this.syncEntities(this.resources, next);
    for (const audit of payload.audits) await this.ledger.appendResourceAudit(audit);
    this.resources.clear();
    for (const [id, resource] of next) this.resources.set(id, structuredClone(resource));
  }

  private async recoverTransactions(): Promise<void> {
    for (const transaction of await this.ledger.listOutstandingTransactions()) {
      if (transaction.kind !== 'resource-mutation') continue;
      try {
        await this.applyTransaction(transaction);
        await this.ledger.commitTransaction(transaction.id);
      } catch (error) {
        await this.ledger.markTransactionRecovery(transaction.id, errorMessage(error));
        this.log?.('warn', `memory-v3: resource transaction ${transaction.id} remains in recovery: ${errorMessage(error)}`);
      }
    }
  }

  private assertEntityRemovalsAllowed(
    current: Map<string, MemoryResourceRegistration>,
    next: Map<string, MemoryResourceRegistration>,
  ): void {
    const retained = new Set([...next.values()].map((resource) => memoryV3ResourceEntityId(resource)));
    for (const resource of current.values()) {
      const entityId = memoryV3ResourceEntityId(resource);
      if (retained.has(entityId)) continue;
      const blockers = this.catalog.entityReferenceBlockers(entityId);
      if (blockers.atomIds.length > 0 || blockers.inboundRelationIds.length > 0 || blockers.outboundRelationIds.length > 0) {
        throw new Error(`Memory resource ${resource.id} cannot be removed while its entity is referenced: ${JSON.stringify(blockers)}`);
      }
    }
  }

  private async syncEntities(
    current: Map<string, MemoryResourceRegistration>,
    next: Map<string, MemoryResourceRegistration>,
  ): Promise<void> {
    const nextEntityIds = new Set<string>();
    for (const resource of next.values()) {
      const entity = await this.resourceEntity(resource);
      nextEntityIds.add(entity.id);
      await this.graphStore.upsertEntity(entity);
    }
    for (const resource of current.values()) {
      const entityId = memoryV3ResourceEntityId(resource);
      if (nextEntityIds.has(entityId)) continue;
      const existing = await this.graphStore.getEntity(entityId);
      if (!existing) continue;
      await this.graphStore.upsertEntity({ ...existing, status: 'deleted', revision: existing.revision + 1, updatedAt: new Date().toISOString() });
      await this.graphStore.purgeEntity(entityId);
    }
  }

  private upsertResourceEntity(resource: MemoryResourceRegistration): Promise<MemoryEntity> {
    return this.resourceEntity(resource).then((entity) => this.graphStore.upsertEntity(entity));
  }

  private async resourceEntity(resource: MemoryResourceRegistration): Promise<MemoryEntity> {
    const id = memoryV3ResourceEntityId(resource);
    const existing = await this.graphStore.getEntity(id);
    const candidate: MemoryEntity = {
      version: 1,
      id,
      type: resourceEntityType(resource),
      owner: resource.owner
        ? { kind: resource.owner.kind === 'user' ? 'user' : resource.owner.kind === 'plugin' ? 'external' : 'system', id: resource.owner.id }
        : { kind: resource.authority === 'authoritative' ? 'system' : 'external' },
      scope: resource.scope,
      scopeKey: resource.scopeKey,
      externalKey: memoryResourceSourceIdentity(resource),
      label: resource.title,
      aliases: existing?.aliases ?? [],
      status: 'active',
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? resource.registeredAt,
      updatedAt: resource.updatedAt,
    };
    if (existing && sameEntityProjection(existing, candidate)) return existing;
    return candidate;
  }

  private pathFor(id: string): string {
    const hash = createHash('sha256').update(id, 'utf8').digest('hex');
    return join(this.rootDir, hash.slice(0, 2), `${hash}.resource.json`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return this.exclusive(operation);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function parseResourceMutationPayload(value: Record<string, unknown>): ResourceMutationPayload {
  if (!Array.isArray(value.upserts) || !Array.isArray(value.removals) || !Array.isArray(value.audits)) {
    throw new Error('Memory v3 resource transaction payload is invalid.');
  }
  return {
    upserts: value.upserts.map((resource) => normalizeMemoryResource(resource as MemoryResourceRegistration)),
    removals: value.removals.map(String),
    audits: value.audits as MemoryResourceManagementAuditRecord[],
  };
}

function cloneResources(source: Map<string, MemoryResourceRegistration>): Map<string, MemoryResourceRegistration> {
  return new Map([...source.entries()].map(([id, resource]) => [id, structuredClone(resource)]));
}

export function memoryV3ResourceEntityId(resource: MemoryResourceRegistration): string {
  return memoryV3EntityId(
    resourceEntityType(resource),
    resource.scope,
    resource.scopeKey,
    memoryResourceSourceIdentity(resource),
  );
}

function resourceEntityType(resource: MemoryResourceRegistration): MemoryEntityType {
  if (resource.kind === 'user-profile') return 'user';
  if (resource.kind === 'skill') return 'skill';
  if (resource.kind === 'taskbook') return 'task';
  if (resource.kind === 'project-memory-projection') return 'project';
  if (['agent-instructions', 'persona', 'philosophy', 'tool-guidance', 'project-guideline', 'ui-guideline']
    .includes(resource.kind)) return 'rule';
  if (resource.kind === 'knowledge' || resource.kind === 'legacy-memory') return 'concept';
  if (resource.source.kind === 'session-summary') return 'session';
  if (resource.source.kind === 'runtime-event') return 'session';
  if (resource.source.kind === 'workspace-index') return 'directory';
  if (resource.source.kind === 'attachment') return 'file';
  if (resource.source.kind === 'file') return 'file';
  return 'external-source';
}

function sameEntityProjection(left: MemoryEntity, right: MemoryEntity): boolean {
  return JSON.stringify({ ...left, revision: 0, createdAt: '', updatedAt: '' })
    === JSON.stringify({ ...right, revision: 0, createdAt: '', updatedAt: '' });
}

async function collectResourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.resource.json')) files.push(path);
      if (files.length > MAX_RESOURCE_FILES) throw new Error(`Memory v3 resource count exceeds ${MAX_RESOURCE_FILES}.`);
    }
  }
  return files.sort();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
