// @littlesheep/memory-tree - atomic tree document and guarded writes.

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import { validateMemoryContent } from '@littlesheep/safety';
import { InjectionTier } from './types.js';
import type {
  LogFn,
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryManagementAuditRecord,
  MemoryManagementResult,
  MemoryMigrationRecord,
  MemoryNode,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryResourceManagementAction,
  MemoryResourceManagementActor,
  MemoryResourceManagementAuditRecord,
  MemoryResourceManagementResult,
  MemoryResourceRebindPatch,
  MemorySchemaMigrationRecord,
  MemoryTreeDocument,
  MemoryTreeDocumentV1,
  MemoryWriteAuditRecord,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from './types.js';

const CURRENT_DOCUMENT_VERSION = 2;
const REGISTRY_VERSION = 1;
const V1_TO_V2_MIGRATION_ID = 'memory-tree-schema-v1-to-v2';
const MAX_T0_RESOURCES = 16;

const ROOTS: Record<MemoryBranchKind, { summary: string; keys: string[] }> = {
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

const DEFAULT_POLICY: MemoryWritePolicy = {
  experienceThreshold: 0.65,
  longTermConfidenceThreshold: 0.75,
  longTermImportanceThreshold: 0.7,
  projectConfidenceThreshold: 0.6,
  duplicateSimilarityThreshold: 0.82,
  maxAuditRecords: 2_000,
};

export interface MemoryRepositoryOptions {
  dataDir: string;
  policy?: Partial<MemoryWritePolicy>;
  log?: LogFn;
}

export interface ReplaceMemoryResourceGroupOptions {
  staleMode?: 'missing' | 'remove';
  audit?: boolean;
  reason?: string;
  /** Owner-controlled groups can intentionally restore a previously disabled resource. */
  preserveDisabled?: boolean;
}

export interface ManageMemoryResourceOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  audit?: boolean;
  restoreStatus?: Exclude<MemoryResourceRegistration['status'], 'disabled'>;
  allowActiveRemoval?: boolean;
}

export interface RebindMemoryResourceOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  replaceConflictingResource?: boolean;
}

export interface RemoveMemoryResourcesOptions {
  actor?: MemoryResourceManagementActor;
  reason?: string;
  audit?: boolean;
  includeActive?: boolean;
}

function rootId(branch: MemoryBranchKind): string {
  return `${branch}:root`;
}

function branchRoots(now: string): Record<string, MemoryNode> {
  return Object.fromEntries(
    (Object.keys(ROOTS) as MemoryBranchKind[]).map((branch) => {
      const spec = ROOTS[branch];
      const id = rootId(branch);
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

function newDocument(now = new Date().toISOString()): MemoryTreeDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    registryVersion: REGISTRY_VERSION,
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cleanText(value: string): string {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function normalized(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/\s+/g, ' ');
}

function terms(value: string): Set<string> {
  const text = normalized(value);
  const result = new Set(text.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1));
  const compactCjk = [...text].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  for (let index = 0; index + 1 < compactCjk.length; index += 1) {
    result.add(compactCjk[index]! + compactCjk[index + 1]!);
  }
  return result;
}

function similarity(left: MemoryNode, right: MemoryWriteIntent): number {
  const a = terms(`${left.summary}\n${left.content}\n${left.retrievalKeys.join(' ')}`);
  const b = terms(`${right.summary}\n${right.content}\n${right.retrievalKeys.join(' ')}`);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function isTemporaryOrEmotional(intent: MemoryWriteIntent): boolean {
  const text = `${intent.summary}\n${intent.content}`;
  return /(?:仅本轮|这一次运行|临时(?:文件|状态|想法)|刚才临时|当前情绪|我现在(?:很|有点)(?:开心|难过|生气|焦虑)|only this run|temporary run state|current mood)/iu.test(text);
}

function validateV1Document(value: unknown): MemoryTreeDocumentV1 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MemoryTreeDocumentV1>;
  if (candidate.version !== 1 || !candidate.nodes || typeof candidate.nodes !== 'object') return null;
  if (!Array.isArray(candidate.recoveryQueue) || !Array.isArray(candidate.writeAudit)) return null;
  if (!Array.isArray(candidate.managementAudit)) candidate.managementAudit = [];
  if (!candidate.migrations || typeof candidate.migrations !== 'object') candidate.migrations = {};
  return candidate as MemoryTreeDocumentV1;
}

function validateV2Document(value: unknown): MemoryTreeDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MemoryTreeDocument>;
  if (candidate.version !== CURRENT_DOCUMENT_VERSION || candidate.registryVersion !== REGISTRY_VERSION) return null;
  if (!candidate.nodes || typeof candidate.nodes !== 'object') return null;
  if (!candidate.resources || typeof candidate.resources !== 'object') candidate.resources = {};
  if (!Array.isArray(candidate.recoveryQueue) || !Array.isArray(candidate.writeAudit)) return null;
  if (!Array.isArray(candidate.managementAudit)) candidate.managementAudit = [];
  if (!Array.isArray(candidate.resourceManagementAudit)) candidate.resourceManagementAudit = [];
  if (!candidate.migrations || typeof candidate.migrations !== 'object') candidate.migrations = {};
  if (!Array.isArray(candidate.schemaMigrations)) candidate.schemaMigrations = [];
  return candidate as MemoryTreeDocument;
}

function migrateV1Document(
  legacy: MemoryTreeDocumentV1,
  migration: MemorySchemaMigrationRecord,
): MemoryTreeDocument {
  return {
    version: CURRENT_DOCUMENT_VERSION,
    registryVersion: REGISTRY_VERSION,
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

function resourceSourceIdentity(resource: MemoryResourceRegistration): string {
  const raw = resource.source.path ?? resource.source.id ?? resource.id;
  return `${resource.source.kind}:${raw.replace(/[\\/]+/g, '/').toLocaleLowerCase()}`;
}

function matchesResourceQuery(resource: MemoryResourceRegistration, query: MemoryResourceQuery): boolean {
  return (!query.kind || resource.kind === query.kind)
    && (query.tier === undefined || resource.tier === query.tier)
    && (!query.branch || resource.branch === query.branch)
    && (!query.scope || resource.scope === query.scope)
    && (!query.scopeKey || resource.scopeKey === query.scopeKey)
    && (!query.status || resource.status === query.status)
    && (!query.registryGroup || resource.registryGroup === query.registryGroup);
}

function sameResourceRegistration(
  left: MemoryResourceRegistration,
  right: MemoryResourceRegistration,
): boolean {
  const comparable = (resource: MemoryResourceRegistration) => ({
    ...resource,
    registeredAt: undefined,
    updatedAt: undefined,
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

export class MemoryRepository {
  readonly rootDir: string;
  readonly indexPath: string;
  private readonly policy: MemoryWritePolicy;
  private readonly log?: LogFn;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryRepositoryOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree');
    this.indexPath = join(this.rootDir, 'index.json');
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    this.log = options.log;
  }

  static branchRootId(branch: MemoryBranchKind): string {
    return rootId(branch);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      await atomicWrite(this.indexPath, JSON.stringify(newDocument(), null, 2));
      return;
    }
    await this.withWriteLock(async () => {
      let document = await this.readStoredDocument();
      let changed = false;
      const legacy = validateV1Document(document);
      if (legacy) {
        const startedAt = new Date().toISOString();
        const backupFile = `index.v1-${startedAt.replace(/[:.]/g, '-')}.backup.json`;
        await copyFile(this.indexPath, join(this.rootDir, backupFile));
        const migration: MemorySchemaMigrationRecord = {
          id: V1_TO_V2_MIGRATION_ID,
          fromVersion: 1,
          toVersion: CURRENT_DOCUMENT_VERSION,
          startedAt,
          completedAt: new Date().toISOString(),
          backupFile,
        };
        document = migrateV1Document(legacy, migration);
        changed = true;
        this.log?.('info', `memory-tree: migrated schema v1 -> v2; backup=${backupFile}`);
      }
      const current = validateV2Document(document);
      if (!current) {
        const version = document && typeof document === 'object' && 'version' in document
          ? Number((document as { version?: unknown }).version)
          : undefined;
        if (Number.isFinite(version)) {
          throw new Error(`memory-tree: unsupported document version ${version}; current runtime supports ${CURRENT_DOCUMENT_VERSION}`);
        }
        throw new Error('memory-tree: unsupported document shape');
      }
      const currentDocument = current;
      const roots = branchRoots(currentDocument.updatedAt);
      for (const [id, node] of Object.entries(roots)) {
        if (!currentDocument.nodes[id]) {
          currentDocument.nodes[id] = node;
          changed = true;
        }
      }
      if (changed) await this.persist(currentDocument);
    });
  }

  async snapshot(): Promise<MemoryTreeDocument> {
    return this.readDocument();
  }

  async getResource(id: string): Promise<MemoryResourceRegistration | undefined> {
    const resource = (await this.readDocument()).resources[id];
    return resource ? structuredClone(resource) : undefined;
  }

  async listResources(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    return Object.values((await this.readDocument()).resources)
      .filter((resource) => matchesResourceQuery(resource, query))
      .sort((left, right) => left.tier - right.tier || left.title.localeCompare(right.title))
      .map((resource) => structuredClone(resource));
  }

  async listResourceManagementAudit(
    resourceId?: string,
    limit = 100,
  ): Promise<MemoryResourceManagementAuditRecord[]> {
    const records = (await this.readDocument()).resourceManagementAudit
      .filter((record) => !resourceId || record.resourceId === resourceId)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(0, limit));
    return structuredClone(records);
  }

  async replaceResourceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options: ReplaceMemoryResourceGroupOptions = {},
  ): Promise<MemoryResourceRegistration[]> {
    const normalizedGroup = cleanText(registryGroup);
    if (!normalizedGroup) throw new Error('必须提供记忆资源注册组。');
    let output: MemoryResourceRegistration[] = [];
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const now = new Date().toISOString();
      let changed = false;
      const incoming = resources.map((resource) => this.normalizeResource({
        ...resource,
        registryGroup: normalizedGroup,
      }));
      const incomingIds = new Set(incoming.map((resource) => resource.id));
      if (incomingIds.size !== incoming.length) {
        throw new Error(`记忆资源注册组 "${normalizedGroup}" 包含重复的资源 ID。`);
      }

      for (const existing of Object.values(document.resources)) {
        if (existing.registryGroup !== normalizedGroup || incomingIds.has(existing.id)) continue;
        if (options.staleMode === 'remove') {
          if (options.audit !== false && existing.scope !== 'run') {
            this.recordResourceAudit(document, existing, 'remove', {
              actor: 'system',
              reason: options.reason ?? `资源已不再出现在注册组 "${normalizedGroup}" 中。`,
            });
          }
          delete document.resources[existing.id];
          changed = true;
          continue;
        }
        if (existing.status === 'missing') continue;
        if (existing.status === 'disabled') continue;
        if (options.audit !== false && existing.scope !== 'run') {
          this.recordResourceAudit(document, existing, 'mark-missing', {
            actor: 'system',
            reason: options.reason ?? `资源已不再出现在注册组 "${normalizedGroup}" 中。`,
            toStatus: 'missing',
          });
        }
        existing.status = 'missing';
        existing.updatedAt = now;
        changed = true;
      }

      for (const resource of incoming) {
        const existing = document.resources[resource.id];
        const next: MemoryResourceRegistration = {
          ...resource,
          registeredAt: existing?.registeredAt ?? resource.registeredAt,
          status: options.preserveDisabled !== false && existing?.status === 'disabled'
            ? 'disabled'
            : resource.status,
        };
        if (existing && resourceSourceIdentity(existing) !== resourceSourceIdentity(next)) {
          throw new Error(`记忆资源 "${resource.id}" 的来源身份已改变；请使用 rebindResource()，以便记录迁移审计。`);
        }
        if (existing && sameResourceRegistration(existing, next)) continue;
        if (existing && existing.status !== next.status && options.audit !== false && existing.scope !== 'run') {
          const action = next.status === 'active'
            ? 'restore'
            : next.status === 'missing'
              ? 'mark-missing'
              : next.status === 'conflict'
                ? 'mark-conflict'
                : 'disable';
          this.recordResourceAudit(document, existing, action, {
            actor: 'system',
            reason: options.reason ?? `注册组 "${normalizedGroup}" 已同步资源状态。`,
            toStatus: next.status,
          });
        }
        document.resources[resource.id] = next;
        changed = true;
      }
      this.validateResourceRegistry(document.resources);
      if (changed) await this.persist(document);
      output = incoming.map((resource) => structuredClone(document.resources[resource.id]!));
    });
    return output;
  }

  async manageResource(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options: ManageMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    let output: MemoryResourceManagementResult | undefined;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const resource = document.resources[resourceId];
      if (!resource) return;
      const fromStatus = resource.status;
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
        const audit = options.audit === false
          ? undefined
          : this.recordResourceAudit(document, resource, action, { actor, reason });
        delete document.resources[resourceId];
        await this.persist(document);
        output = {
          changed: true,
          removed: true,
          audit: audit ? structuredClone(audit) : undefined,
        };
        return;
      }

      let toStatus = fromStatus;
      if (action === 'disable') toStatus = 'disabled';
      else if (action === 'restore') toStatus = options.restoreStatus ?? 'active';
      else if (action === 'mark-missing' && fromStatus !== 'disabled') toStatus = 'missing';
      else if (action === 'mark-conflict' && fromStatus !== 'disabled') toStatus = 'conflict';

      if (toStatus === fromStatus) {
        output = { resource: structuredClone(resource), changed: false, removed: false };
        return;
      }

      resource.status = toStatus;
      resource.updatedAt = new Date().toISOString();
      this.validateResourceRegistry(document.resources);
      const audit = options.audit === false
        ? undefined
        : this.recordResourceAudit(document, resource, action, {
            actor,
            reason,
            fromStatus,
            toStatus,
          });
      await this.persist(document);
      output = {
        resource: structuredClone(resource),
        changed: true,
        removed: false,
        audit: audit ? structuredClone(audit) : undefined,
      };
    });
    return output;
  }

  async rebindResource(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options: RebindMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    let output: MemoryResourceManagementResult | undefined;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const resource = document.resources[resourceId];
      if (!resource) return;
      if (resource.source.kind !== 'file') throw new Error('只有文件来源的记忆资源可以重新绑定。');
      const fromSourcePath = resource.source.path;
      const targetPath = normalizedFilePath(patch.sourcePath);
      if (fromSourcePath && sameFilePath(fromSourcePath, targetPath)
        && patch.scopeKey === undefined
        && patch.title === undefined
        && patch.kind === undefined
        && patch.indexKeys === undefined
        && patch.contentHash === undefined
        && patch.status === undefined) {
        output = { resource: structuredClone(resource), changed: false, removed: false };
        return;
      }

      const updated: MemoryResourceRegistration = this.normalizeResource({
        ...resource,
        title: patch.title ?? resource.title,
        kind: patch.kind ?? resource.kind,
        scopeKey: patch.scopeKey ?? resource.scopeKey,
        indexKeys: patch.indexKeys ?? resource.indexKeys,
        source: {
          ...resource.source,
          path: targetPath,
          contentHash: patch.contentHash ?? resource.source.contentHash,
        },
        status: resource.status === 'disabled' ? 'disabled' : patch.status ?? 'active',
        updatedAt: new Date().toISOString(),
      });
      const conflicting = Object.values(document.resources).find((candidate) => (
        candidate.id !== resourceId
        && candidate.status === 'active'
        && candidate.authority === 'authoritative'
        && resourceSourceIdentity(candidate) === resourceSourceIdentity(updated)
      ));
      if (conflicting) {
        const replaceable = options.replaceConflictingResource === true
          && conflicting.registryGroup === resource.registryGroup
          && conflicting.scope === resource.scope
          && conflicting.scopeKey === resource.scopeKey;
        if (!replaceable) {
          throw new Error(`权威记忆资源 "${conflicting.id}" 已引用目标来源，无法直接重新绑定。`);
        }
        this.recordResourceAudit(document, conflicting, 'remove', {
          actor: options.actor ?? 'user',
          reason: `重新定位时，已将自动发现的替代登记合并到稳定资源 "${resourceId}"。`,
        });
        delete document.resources[conflicting.id];
      }
      document.resources[resourceId] = updated;
      this.validateResourceRegistry(document.resources);
      const audit = this.recordResourceAudit(document, resource, 'rebind', {
        actor: options.actor ?? 'user',
        reason: options.reason ?? '记忆资源来源已重新定位。',
        toStatus: updated.status,
        fromSourcePath,
        toSourcePath: targetPath,
      });
      await this.persist(document);
      output = {
        resource: structuredClone(updated),
        changed: true,
        removed: false,
        audit: structuredClone(audit),
      };
    });
    return output;
  }

  async removeResources(
    query: MemoryResourceQuery,
    options: RemoveMemoryResourcesOptions = {},
  ): Promise<number> {
    let removed = 0;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      for (const resource of Object.values(document.resources)) {
        if (!matchesResourceQuery(resource, query)) continue;
        if (resource.status === 'active' && options.includeActive !== true) continue;
        if (options.audit !== false && resource.scope !== 'run') {
          this.recordResourceAudit(document, resource, 'remove', {
            actor: options.actor ?? 'system',
            reason: options.reason ?? '记忆资源登记已清理。',
          });
        }
        delete document.resources[resource.id];
        removed += 1;
      }
      if (removed > 0) await this.persist(document);
    });
    return removed;
  }

  /** Emergency operator rollback. The next normal initialize will migrate the restored v1 file again. */
  async restoreSchemaBackup(backupFile: string): Promise<void> {
    const safeName = basename(backupFile);
    if (safeName !== backupFile || !/^index\.v1-.+\.backup\.json$/u.test(safeName)) {
      throw new Error('Invalid memory-tree schema backup name.');
    }
    await this.withWriteLock(async () => {
      const backupPath = join(this.rootDir, safeName);
      const parsed = JSON.parse(await readFile(backupPath, 'utf8')) as unknown;
      if (!validateV1Document(parsed)) throw new Error('Memory-tree schema backup is not a valid v1 document.');
      await atomicWrite(this.indexPath, JSON.stringify(parsed, null, 2));
    });
  }

  async getNode(id: string): Promise<MemoryNode | undefined> {
    const node = (await this.readDocument()).nodes[id];
    return node ? structuredClone(node) : undefined;
  }

  async listNodes(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> {
    const document = await this.readDocument();
    return Object.values(document.nodes)
      .filter((node) => node.branch === branch && !node.isBranchRoot && node.status === 'active')
      .filter((node) => !scopeKey || !node.scopeKey || node.scopeKey === scopeKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((node) => structuredClone(node));
  }

  async rebindProjectPath(fromPath: string, toPath: string): Promise<{
    nodeCount: number;
    recoveryIntentCount: number;
    resourceCount: number;
  }> {
    const from = normalizedFilePath(fromPath);
    const to = normalizedFilePath(toPath);
    const result = { nodeCount: 0, recoveryIntentCount: 0, resourceCount: 0 };
    if (sameFilePath(from, to)) return result;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      for (const node of Object.values(document.nodes)) {
        if (node.branch !== 'project' || !node.scopeKey || !sameFilePath(node.scopeKey, from)) continue;
        node.scopeKey = to;
        result.nodeCount += 1;
      }
      for (const queued of document.recoveryQueue) {
        if (queued.intent.branch !== 'project'
          || !queued.intent.scopeKey
          || !sameFilePath(queued.intent.scopeKey, from)) continue;
        queued.intent.scopeKey = to;
        result.recoveryIntentCount += 1;
      }
      for (const resource of Object.values(document.resources)) {
        if (resource.branch !== 'project' || !resource.scopeKey || !sameFilePath(resource.scopeKey, from)) continue;
        const fromSourcePath = resource.source.path;
        resource.scopeKey = to;
        if (resource.source.path) resource.source.path = rebaseFilePath(resource.source.path, from, to);
        resource.updatedAt = new Date().toISOString();
        this.recordResourceAudit(document, resource, 'rebind', {
          actor: 'system',
          reason: '项目路径已重新绑定，并保留资源身份。',
          fromSourcePath,
          toSourcePath: resource.source.path,
        });
        result.resourceCount += 1;
      }
      if (result.nodeCount > 0 || result.recoveryIntentCount > 0 || result.resourceCount > 0) {
        this.validateResourceRegistry(document.resources);
        await this.persist(document);
      }
    });
    return result;
  }

  async children(parentNodeId: string): Promise<MemoryNode[]> {
    const document = await this.readDocument();
    const parent = document.nodes[parentNodeId];
    if (!parent) return [];
    return parent.childIds
      .map((id) => document.nodes[id])
      .filter((node): node is MemoryNode => !!node && node.status === 'active')
      .map((node) => structuredClone(node));
  }

  async write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    let result!: MemoryWriteResult;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      result = this.applyIntent(document, this.normalizeIntent(intent));
      await this.persist(document);
    });
    return result;
  }

  async retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> {
    const results: MemoryWriteResult[] = [];
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const pending = document.recoveryQueue.splice(0, limit);
      for (const queued of pending) {
        if (queued.attempts >= 3) {
          document.recoveryQueue.push(queued);
          continue;
        }
        const result = this.applyIntent(document, queued.intent, false);
        if (result.decision === 'queued') {
          const replacement = document.recoveryQueue.at(-1);
          if (replacement) replacement.attempts = queued.attempts + 1;
        }
        results.push(result);
      }
      await this.persist(document);
    });
    return results;
  }

  async setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    let output: MemoryNode | undefined;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return;
      node.status = status;
      node.updatedAt = new Date().toISOString();
      this.refreshAncestors(document, node.parentNodeId);
      await this.persist(document);
      output = structuredClone(node);
    });
    return output;
  }

  async changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    let output: MemoryNode | undefined;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return;
      node.tier = tier;
      node.updatedAt = new Date().toISOString();
      await this.persist(document);
      output = structuredClone(node);
    });
    return output;
  }

  async manageNode(
    nodeId: string,
    action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.',
  ): Promise<MemoryManagementResult | undefined> {
    let output: MemoryManagementResult | undefined;
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return;

      const liveChildren = node.childIds
        .map((id) => document.nodes[id])
        .filter((child): child is MemoryNode => !!child && child.status !== 'deleted');
      if ((action === 'archive' || action === 'delete') && liveChildren.length > 0) {
        throw new Error('Manage child memories before changing this parent memory.');
      }

      const fromStatus = node.status;
      const fromTier = node.tier;
      if (action === 'archive') {
        if (node.status !== 'active') throw new Error('Only active memories can be archived.');
        node.status = 'archived';
      } else if (action === 'restore') {
        if (node.status !== 'archived') throw new Error('Only archived memories can be restored.');
        const parent = node.parentNodeId ? document.nodes[node.parentNodeId] : undefined;
        if (!parent || parent.status !== 'active') throw new Error('Restore the parent memory before restoring this item.');
        node.status = 'active';
      } else if (action === 'delete') {
        if (node.status === 'deleted') throw new Error('This memory has already been deleted.');
        node.status = 'deleted';
      } else {
        if (node.status !== 'active') throw new Error('Only active memories can change injection tier.');
        const highestTier = node.branch === 'daily' ? InjectionTier.T2_RELEVANT : InjectionTier.T1_ESSENTIAL;
        if (action === 'promote') {
          if (node.tier <= highestTier) throw new Error('This memory is already at its highest allowed tier.');
          node.tier = node.tier - 1 as InjectionTier;
        } else {
          if (node.tier >= InjectionTier.T3_DETAIL) throw new Error('This memory is already at T3.');
          node.tier = node.tier + 1 as InjectionTier;
        }
      }

      const now = new Date().toISOString();
      node.updatedAt = now;
      this.refreshAncestors(document, node.parentNodeId);
      const audit: MemoryManagementAuditRecord = {
        id: randomUUID(),
        nodeId: node.id,
        branch: node.branch,
        action,
        at: now,
        reason: cleanText(reason).slice(0, 500) || 'Memory-tree management action.',
        fromStatus,
        toStatus: node.status,
        fromTier,
        toTier: node.tier,
      };
      document.managementAudit.push(audit);
      if (document.managementAudit.length > this.policy.maxAuditRecords) {
        document.managementAudit.splice(0, document.managementAudit.length - this.policy.maxAuditRecords);
      }
      await this.persist(document);
      output = { node: structuredClone(node), audit: structuredClone(audit) };
    });
    return output;
  }

  async getMigration(id: string): Promise<MemoryMigrationRecord | undefined> {
    const migration = (await this.readDocument()).migrations[id];
    return migration ? structuredClone(migration) : undefined;
  }

  async markMigration(record: MemoryMigrationRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      document.migrations[record.id] = structuredClone(record);
      await this.persist(document);
    });
  }

  private normalizeResource(resource: MemoryResourceRegistration): MemoryResourceRegistration {
    const now = new Date().toISOString();
    const indexKeys = unique(resource.indexKeys.map((key) => cleanText(key).toLocaleLowerCase())).slice(0, 32);
    const source = {
      ...resource.source,
      path: resource.source.path ? cleanText(resource.source.path) : undefined,
      id: resource.source.id ? cleanText(resource.source.id) : undefined,
      contentHash: resource.source.contentHash ? cleanText(resource.source.contentHash) : undefined,
    };
    const normalized: MemoryResourceRegistration = {
      ...resource,
      version: 1,
      id: cleanText(resource.id),
      title: cleanText(resource.title).slice(0, 240),
      description: cleanText(resource.description).slice(0, 500),
      scopeKey: resource.scopeKey ? cleanText(resource.scopeKey) : undefined,
      owner: resource.owner ? {
        kind: resource.owner.kind,
        id: cleanText(resource.owner.id),
        controller: resource.owner.controller,
      } : undefined,
      source,
      indexKeys,
      registryGroup: cleanText(resource.registryGroup),
      registeredAt: resource.registeredAt || now,
      updatedAt: resource.updatedAt || now,
    };
    if (!normalized.id || !normalized.title || !normalized.description || !normalized.registryGroup) {
      throw new Error('Memory resource requires id, title, description and registryGroup.');
    }
    if (normalized.owner && !normalized.owner.id) {
      throw new Error(`Memory resource "${normalized.id}" has an invalid lifecycle owner.`);
    }
    if (!normalized.source.path && !normalized.source.id) {
      throw new Error(`Memory resource "${normalized.id}" has no authoritative source reference.`);
    }
    if ((normalized.scope === 'workspace' || normalized.scope === 'project' || normalized.scope === 'session' || normalized.scope === 'run') && !normalized.scopeKey) {
      throw new Error(`Memory resource "${normalized.id}" requires a scope key for ${normalized.scope} scope.`);
    }
    if (normalized.tier === InjectionTier.T0_CORE && normalized.scope !== 'global') {
      throw new Error(`T0 memory resource "${normalized.id}" must use global scope.`);
    }
    return normalized;
  }

  private validateResourceRegistry(resources: Record<string, MemoryResourceRegistration>): void {
    const active = Object.values(resources).filter((resource) => resource.status === 'active');
    const t0Count = active.filter((resource) => resource.tier === InjectionTier.T0_CORE).length;
    if (t0Count > MAX_T0_RESOURCES) {
      throw new Error(`T0 memory resource limit exceeded (${t0Count}/${MAX_T0_RESOURCES}).`);
    }
    const authoritativeSources = new Map<string, string>();
    for (const resource of active) {
      if (resource.authority !== 'authoritative') continue;
      const identity = resourceSourceIdentity(resource);
      const existing = authoritativeSources.get(identity);
      if (existing && existing !== resource.id) {
        throw new Error(`Conflicting authoritative memory resources "${existing}" and "${resource.id}" reference the same source.`);
      }
      authoritativeSources.set(identity, resource.id);
    }
  }

  private recordResourceAudit(
    document: MemoryTreeDocument,
    resource: MemoryResourceRegistration,
    action: MemoryResourceManagementAction,
    options: {
      actor: MemoryResourceManagementActor;
      reason: string;
      fromStatus?: MemoryResourceRegistration['status'];
      toStatus?: MemoryResourceRegistration['status'];
      fromSourcePath?: string;
      toSourcePath?: string;
    },
  ): MemoryResourceManagementAuditRecord {
    const audit: MemoryResourceManagementAuditRecord = {
      id: randomUUID(),
      resourceId: resource.id,
      resourceKind: resource.kind,
      registryGroup: resource.registryGroup,
      action,
      actor: options.actor,
      at: new Date().toISOString(),
      reason: cleanText(options.reason).slice(0, 500) || '记忆资源生命周期操作。',
      fromStatus: options.fromStatus ?? resource.status,
      toStatus: options.toStatus,
      fromSourcePath: options.fromSourcePath,
      toSourcePath: options.toSourcePath,
    };
    document.resourceManagementAudit.push(audit);
    if (document.resourceManagementAudit.length > this.policy.maxAuditRecords) {
      document.resourceManagementAudit.splice(
        0,
        document.resourceManagementAudit.length - this.policy.maxAuditRecords,
      );
    }
    return audit;
  }

  private normalizeIntent(intent: MemoryWriteIntent): MemoryWriteIntent {
    return {
      ...intent,
      id: intent.id ?? randomUUID(),
      parentNodeId: cleanText(intent.parentNodeId),
      scopeKey: intent.scopeKey ? cleanText(intent.scopeKey) : undefined,
      summary: cleanText(intent.summary),
      content: cleanText(intent.content),
      retrievalKeys: unique(intent.retrievalKeys.map((key) => cleanText(key).toLocaleLowerCase())).slice(0, 24),
      sourceRefs: unique((intent.sourceRefs ?? []).map((source) => cleanText(source))).slice(0, 24),
      reason: cleanText(intent.reason),
      importance: clamp01(intent.importance),
      confidence: clamp01(intent.confidence),
      createdAt: intent.createdAt ?? new Date().toISOString(),
    };
  }

  private applyIntent(
    document: MemoryTreeDocument,
    intent: MemoryWriteIntent,
    queueOnMissingParent = true,
  ): MemoryWriteResult {
    const intentId = intent.id!;
    const rejection = this.rejectionReason(intent);
    if (rejection) {
      this.audit(document, intent, 'rejected', rejection);
      return { intentId, decision: 'rejected', reason: rejection };
    }

    const parent = document.nodes[intent.parentNodeId];
    if (!parent || parent.branch !== intent.branch || parent.status !== 'active') {
      const reason = `Parent node "${intent.parentNodeId}" is unavailable in branch "${intent.branch}".`;
      if (queueOnMissingParent) {
        const queuedId = randomUUID();
        document.recoveryQueue.push({ id: queuedId, intent, error: reason, queuedAt: new Date().toISOString(), attempts: 0 });
        this.audit(document, intent, 'queued', reason);
        return { intentId, decision: 'queued', reason, queuedId };
      }
      this.audit(document, intent, 'queued', reason);
      document.recoveryQueue.push({ id: randomUUID(), intent, error: reason, queuedAt: new Date().toISOString(), attempts: 1 });
      return { intentId, decision: 'queued', reason };
    }

    const candidates = Object.values(document.nodes).filter((node) =>
      !node.isBranchRoot
      && node.status === 'active'
      && node.branch === intent.branch
      && node.scope === intent.scope
      && (node.scopeKey ?? '') === (intent.scopeKey ?? ''),
    );
    const exact = candidates.find((node) =>
      normalized(node.summary) === normalized(intent.summary)
      && normalized(node.content) === normalized(intent.content),
    );
    if (exact) {
      this.reinforce(exact, intent);
      this.refreshAncestors(document, exact.parentNodeId);
      this.audit(document, intent, 'reinforced', 'An equivalent indexed memory already exists; provenance and confidence were reinforced.', exact.id);
      return {
        intentId,
        decision: 'reinforced',
        reason: 'Equivalent indexed memory reinforced.',
        node: structuredClone(exact),
      };
    }

    const similar = candidates
      .map((node) => ({ node, score: similarity(node, intent) }))
      .sort((left, right) => right.score - left.score)[0];
    if (similar && similar.score >= this.policy.duplicateSimilarityThreshold) {
      this.merge(similar.node, intent);
      this.refreshAncestors(document, similar.node.parentNodeId);
      const reason = `Merged with indexed memory ${similar.node.id} (similarity ${similar.score.toFixed(2)}).`;
      this.audit(document, intent, 'merged', reason, similar.node.id);
      return { intentId, decision: 'merged', reason, node: structuredClone(similar.node) };
    }

    const now = intent.createdAt!;
    const node: MemoryNode = {
      id: randomUUID(),
      branch: intent.branch,
      parentNodeId: parent.id,
      childIds: [],
      scope: intent.scope,
      scopeKey: intent.scopeKey,
      tier: intent.tier,
      summary: intent.summary,
      content: intent.content,
      retrievalKeys: intent.retrievalKeys,
      importance: intent.importance,
      confidence: intent.confidence,
      reason: intent.reason,
      sourceRunIds: [intent.sourceRunId],
      sourceStages: [intent.sourceStage],
      sourceRefs: intent.sourceRefs,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    document.nodes[node.id] = node;
    parent.childIds = unique([...parent.childIds, node.id]);
    this.refreshAncestors(document, parent.id);
    this.audit(document, intent, 'created', 'Created an indexed memory node and refreshed its parent index.', node.id);
    return { intentId, decision: 'created', reason: 'Indexed memory created.', node: structuredClone(node) };
  }

  private rejectionReason(intent: MemoryWriteIntent): string | undefined {
    if (!intent.summary || !intent.content || !intent.reason || intent.retrievalKeys.length === 0) {
      return 'Missing summary, content, retrieval keys or write reason.';
    }
    if (intent.summary.length > 240 || intent.content.length > 4_000 || intent.reason.length > 500) {
      return 'Memory intent exceeds the indexed summary/content/reason size limit.';
    }
    const safety = validateMemoryContent(intent.content, { maxLength: 4_000 });
    if (!safety.ok) return `Memory content rejected by write-side safety: ${safety.reason ?? 'unsafe content'}.`;
    if (!intent.sourceRunId) return 'Missing source run id.';
    if (intent.tier === InjectionTier.T0_CORE) return 'Autonomous memory writes cannot target the fixed T0 registry tier.';
    if ((intent.scope === 'workspace' || intent.scope === 'project' || intent.scope === 'session') && !intent.scopeKey) {
      return `Scope "${intent.scope}" requires a scope key.`;
    }
    if (intent.branch === 'long-term') {
      if (intent.scope !== 'global') return 'Long-term memory must have global scope.';
      if (intent.confidence < this.policy.longTermConfidenceThreshold) return 'Long-term memory confidence is below the configured threshold.';
      if (intent.importance < this.policy.longTermImportanceThreshold) return 'Long-term memory importance is below the configured threshold.';
      if (isTemporaryOrEmotional(intent)) return 'Temporary, emotional or single-run state is not durable long-term memory.';
    }
    if (intent.branch === 'experience' && intent.confidence < this.policy.experienceThreshold) {
      return 'Experience confidence is below the balanced learning threshold.';
    }
    if (intent.branch === 'project') {
      if (intent.scope !== 'workspace' && intent.scope !== 'project') return 'Project memory requires workspace or project scope.';
      if (intent.confidence < this.policy.projectConfidenceThreshold) return 'Project memory confidence is below the configured threshold.';
    }
    if (intent.branch === 'daily' && intent.tier === InjectionTier.T1_ESSENTIAL) {
      return 'Daily process records cannot be promoted directly to T1 during capture.';
    }
    return undefined;
  }

  private reinforce(node: MemoryNode, intent: MemoryWriteIntent): void {
    node.confidence = Math.max(node.confidence, intent.confidence);
    node.importance = Math.max(node.importance, intent.importance);
    node.retrievalKeys = unique([...node.retrievalKeys, ...intent.retrievalKeys]);
    node.sourceRunIds = unique([...node.sourceRunIds, intent.sourceRunId]);
    node.sourceStages = unique([...node.sourceStages, intent.sourceStage]);
    node.sourceRefs = unique([...(node.sourceRefs ?? []), ...(intent.sourceRefs ?? [])]);
    node.reason = intent.reason || node.reason;
    node.updatedAt = new Date().toISOString();
  }

  private merge(node: MemoryNode, intent: MemoryWriteIntent): void {
    const shouldReplace = intent.confidence >= node.confidence && intent.content.length >= Math.floor(node.content.length * 0.7);
    if (shouldReplace) {
      node.summary = intent.summary;
      node.content = intent.content;
      node.reason = intent.reason;
    }
    node.retrievalKeys = unique([...node.retrievalKeys, ...intent.retrievalKeys]);
    node.sourceRunIds = unique([...node.sourceRunIds, intent.sourceRunId]);
    node.sourceStages = unique([...node.sourceStages, intent.sourceStage]);
    node.sourceRefs = unique([...(node.sourceRefs ?? []), ...(intent.sourceRefs ?? [])]);
    node.mergedFrom = unique([...(node.mergedFrom ?? []), intent.id!]);
    node.importance = Math.max(node.importance, intent.importance);
    node.confidence = Math.max(node.confidence, intent.confidence);
    node.updatedAt = new Date().toISOString();
  }

  private refreshAncestors(document: MemoryTreeDocument, startingId: string | undefined): void {
    let currentId = startingId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = document.nodes[currentId];
      if (!node) break;
      const activeChildren = node.childIds
        .map((id) => document.nodes[id])
        .filter((child): child is MemoryNode => !!child && child.status === 'active');
      if (node.isBranchRoot) {
        const base = ROOTS[node.branch].summary;
        const recent = activeChildren.slice(-3).map((child) => child.summary).join(' | ');
        node.summary = `${base} ${activeChildren.length} indexed item(s).${recent ? ` Recent: ${recent}` : ''}`;
      }
      node.retrievalKeys = unique([
        ...node.retrievalKeys,
        ...activeChildren.flatMap((child) => child.retrievalKeys.slice(0, 4)),
      ]).slice(0, 64);
      node.updatedAt = new Date().toISOString();
      currentId = node.parentNodeId;
    }
  }

  private audit(
    document: MemoryTreeDocument,
    intent: MemoryWriteIntent,
    decision: MemoryWriteAuditRecord['decision'],
    reason: string,
    nodeId?: string,
  ): void {
    document.writeAudit.push({
      id: randomUUID(),
      intentId: intent.id!,
      sourceRunId: intent.sourceRunId,
      branch: intent.branch,
      at: new Date().toISOString(),
      decision,
      nodeId,
      reason,
    });
    if (document.writeAudit.length > this.policy.maxAuditRecords) {
      document.writeAudit.splice(0, document.writeAudit.length - this.policy.maxAuditRecords);
    }
  }

  private async readStoredDocument(): Promise<unknown> {
    if (!existsSync(this.indexPath)) return newDocument();
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
      const rebuilt = newDocument();
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
        toVersion: CURRENT_DOCUMENT_VERSION,
        startedAt: now,
        completedAt: now,
        backupFile: '',
      });
    }
    const version = parsed && typeof parsed === 'object' && 'version' in parsed
      ? Number((parsed as { version?: unknown }).version)
      : undefined;
    if (Number.isFinite(version)) {
      throw new Error(`memory-tree: unsupported document version ${version}; refusing to rebuild or overwrite it`);
    }
    throw new Error('memory-tree: unsupported document shape');
  }

  private async persist(document: MemoryTreeDocument): Promise<void> {
    document.updatedAt = new Date().toISOString();
    await mkdir(this.rootDir, { recursive: true });
    await atomicWrite(this.indexPath, JSON.stringify(document, null, 2));
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizedFilePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, '');
}

function sameFilePath(left: string, right: string): boolean {
  return normalizedFilePath(left).toLocaleLowerCase() === normalizedFilePath(right).toLocaleLowerCase();
}

function pathInsideOrSame(root: string, path: string): boolean {
  const rel = relative(normalizedFilePath(root), normalizedFilePath(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function rebaseFilePath(path: string, fromRoot: string, toRoot: string): string {
  const normalized = normalizedFilePath(path);
  if (!pathInsideOrSame(fromRoot, normalized)) return normalized;
  const rel = relative(normalizedFilePath(fromRoot), normalized);
  return rel ? resolve(normalizedFilePath(toRoot), rel) : normalizedFilePath(toRoot);
}

export interface MemoryWriteServiceOptions {
  repository: MemoryRepository;
  invalidate: (branch: MemoryBranchKind) => void | Promise<void>;
  log?: LogFn;
}

export class MemoryWriteService {
  private readonly repository: MemoryRepository;
  private readonly invalidate: MemoryWriteServiceOptions['invalidate'];
  private readonly log?: LogFn;

  constructor(options: MemoryWriteServiceOptions) {
    this.repository = options.repository;
    this.invalidate = options.invalidate;
    this.log = options.log;
  }

  async write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    const result = await this.repository.write(intent);
    if (result.decision === 'created' || result.decision === 'merged' || result.decision === 'reinforced') {
      try {
        await this.invalidate(intent.branch);
      } catch (error) {
        this.log?.('warn', `memory-tree: post-write invalidation failed: ${(error as Error).message}`);
      }
    }
    return result;
  }

  async writeMany(intents: MemoryWriteIntent[]): Promise<MemoryWriteResult[]> {
    const results: MemoryWriteResult[] = [];
    for (const intent of intents) {
      try {
        results.push(await this.write(intent));
      } catch (error) {
        this.log?.('warn', `memory-tree: write failed for ${intent.branch}: ${(error as Error).message}`);
        results.push({
          intentId: intent.id ?? 'unknown',
          decision: 'queued',
          reason: `Write failed before persistence: ${(error as Error).message}`,
        });
      }
    }
    return results;
  }
}

export type MemoryWriteServiceLike = Pick<MemoryWriteService, 'write' | 'writeMany'>;
