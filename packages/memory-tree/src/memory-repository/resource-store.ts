// Owns memory resource registration, lifecycle validation, and resource audit records.

import { randomUUID } from 'node:crypto';
import { InjectionTier } from '../types.js';
import type {
  MemoryResourceManagementAction,
  MemoryResourceManagementAuditRecord,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryResourceRebindPatch,
  MemoryTreeDocument,
  MemoryWritePolicy,
} from '../types.js';
import type {
  ManageMemoryResourceOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './contracts.js';
import type { MemoryDocumentStore } from './document-store.js';
import { normalizedFilePath, sameFilePath } from './path-utils.js';
import { cleanText, unique } from './text.js';

const MAX_T0_RESOURCES = 16;

export function memoryResourceSourceIdentity(resource: MemoryResourceRegistration): string {
  const raw = resource.source.path ?? resource.source.id ?? resource.id;
  return `${resource.source.kind}:${raw.replace(/[\\/]+/g, '/').toLocaleLowerCase()}`;
}

export function matchesMemoryResourceQuery(
  resource: MemoryResourceRegistration,
  query: MemoryResourceQuery,
): boolean {
  return (!query.kind || resource.kind === query.kind)
    && (query.tier === undefined || resource.tier === query.tier)
    && (!query.branch || resource.branch === query.branch)
    && (!query.scope || resource.scope === query.scope)
    && (!query.scopeKey || resource.scopeKey === query.scopeKey)
    && (!query.status || resource.status === query.status)
    && (!query.registryGroup || resource.registryGroup === query.registryGroup);
}

export function normalizeMemoryResource(resource: MemoryResourceRegistration): MemoryResourceRegistration {
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
  if ((normalized.scope === 'workspace'
    || normalized.scope === 'project'
    || normalized.scope === 'session'
    || normalized.scope === 'run') && !normalized.scopeKey) {
    throw new Error(`Memory resource "${normalized.id}" requires a scope key for ${normalized.scope} scope.`);
  }
  if (normalized.tier === InjectionTier.T0_CORE && normalized.scope !== 'global') {
    throw new Error(`T0 memory resource "${normalized.id}" must use global scope.`);
  }
  return normalized;
}

export function validateMemoryResourceRegistry(resources: Record<string, MemoryResourceRegistration>): void {
  const active = Object.values(resources).filter((resource) => resource.status === 'active');
  const t0Count = active.filter((resource) => resource.tier === InjectionTier.T0_CORE).length;
  if (t0Count > MAX_T0_RESOURCES) {
    throw new Error(`T0 memory resource limit exceeded (${t0Count}/${MAX_T0_RESOURCES}).`);
  }
  const authoritativeSources = new Map<string, string>();
  for (const resource of active) {
    if (resource.authority !== 'authoritative') continue;
    const identity = memoryResourceSourceIdentity(resource);
    const existing = authoritativeSources.get(identity);
    if (existing && existing !== resource.id) {
      throw new Error(`Conflicting authoritative memory resources "${existing}" and "${resource.id}" reference the same source.`);
    }
    authoritativeSources.set(identity, resource.id);
  }
}

export function recordMemoryResourceAudit(
  document: MemoryTreeDocument,
  resource: MemoryResourceRegistration,
  action: MemoryResourceManagementAction,
  policy: MemoryWritePolicy,
  options: {
    actor: MemoryResourceManagementAuditRecord['actor'];
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
  if (document.resourceManagementAudit.length > policy.maxAuditRecords) {
    document.resourceManagementAudit.splice(
      0,
      document.resourceManagementAudit.length - policy.maxAuditRecords,
    );
  }
  return audit;
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

export class MemoryResourceStore {
  constructor(
    private readonly documents: MemoryDocumentStore,
    private readonly policy: MemoryWritePolicy,
  ) {}

  async get(id: string): Promise<MemoryResourceRegistration | undefined> {
    const resource = (await this.documents.read()).resources[id];
    return resource ? structuredClone(resource) : undefined;
  }

  async list(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    return Object.values((await this.documents.read()).resources)
      .filter((resource) => matchesMemoryResourceQuery(resource, query))
      .sort((left, right) => left.tier - right.tier || left.title.localeCompare(right.title))
      .map((resource) => structuredClone(resource));
  }

  async listAudit(resourceId?: string, limit = 100): Promise<MemoryResourceManagementAuditRecord[]> {
    const records = (await this.documents.read()).resourceManagementAudit
      .filter((record) => !resourceId || record.resourceId === resourceId)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, Math.max(0, limit));
    return structuredClone(records);
  }

  replaceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options: ReplaceMemoryResourceGroupOptions = {},
  ): Promise<MemoryResourceRegistration[]> {
    const normalizedGroup = cleanText(registryGroup);
    if (!normalizedGroup) throw new Error('必须提供记忆资源注册组。');
    return this.documents.update<MemoryResourceRegistration[]>((document) => {
      const now = new Date().toISOString();
      let changed = false;
      const incoming = resources.map((resource) => normalizeMemoryResource({
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
            recordMemoryResourceAudit(document, existing, 'remove', this.policy, {
              actor: 'system',
              reason: options.reason ?? `资源已不再出现在注册组 "${normalizedGroup}" 中。`,
            });
          }
          delete document.resources[existing.id];
          changed = true;
          continue;
        }
        if (existing.status === 'missing' || existing.status === 'disabled') continue;
        if (options.audit !== false && existing.scope !== 'run') {
          recordMemoryResourceAudit(document, existing, 'mark-missing', this.policy, {
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
        if (existing && memoryResourceSourceIdentity(existing) !== memoryResourceSourceIdentity(next)) {
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
          recordMemoryResourceAudit(document, existing, action, this.policy, {
            actor: 'system',
            reason: options.reason ?? `注册组 "${normalizedGroup}" 已同步资源状态。`,
            toStatus: next.status,
          });
        }
        document.resources[resource.id] = next;
        changed = true;
      }
      validateMemoryResourceRegistry(document.resources);
      return {
        value: incoming.map((resource) => structuredClone(document.resources[resource.id]!)),
        changed,
      };
    });
  }

  manage(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options: ManageMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.documents.update<MemoryResourceManagementResult | undefined>((document) => {
      const resource = document.resources[resourceId];
      if (!resource) return { value: undefined, changed: false };
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
          : recordMemoryResourceAudit(document, resource, action, this.policy, { actor, reason });
        delete document.resources[resourceId];
        return {
          value: {
            changed: true,
            removed: true,
            audit: audit ? structuredClone(audit) : undefined,
          },
          changed: true,
        };
      }

      let toStatus = fromStatus;
      if (action === 'disable') toStatus = 'disabled';
      else if (action === 'restore') toStatus = options.restoreStatus ?? 'active';
      else if (action === 'mark-missing' && fromStatus !== 'disabled') toStatus = 'missing';
      else if (action === 'mark-conflict' && fromStatus !== 'disabled') toStatus = 'conflict';

      if (toStatus === fromStatus) {
        return {
          value: { resource: structuredClone(resource), changed: false, removed: false },
          changed: false,
        };
      }

      resource.status = toStatus;
      resource.updatedAt = new Date().toISOString();
      validateMemoryResourceRegistry(document.resources);
      const audit = options.audit === false
        ? undefined
        : recordMemoryResourceAudit(document, resource, action, this.policy, {
            actor,
            reason,
            fromStatus,
            toStatus,
          });
      return {
        value: {
          resource: structuredClone(resource),
          changed: true,
          removed: false,
          audit: audit ? structuredClone(audit) : undefined,
        },
        changed: true,
      };
    });
  }

  rebind(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options: RebindMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.documents.update<MemoryResourceManagementResult | undefined>((document) => {
      const resource = document.resources[resourceId];
      if (!resource) return { value: undefined, changed: false };
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
        return {
          value: { resource: structuredClone(resource), changed: false, removed: false },
          changed: false,
        };
      }

      const updated = normalizeMemoryResource({
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
        && memoryResourceSourceIdentity(candidate) === memoryResourceSourceIdentity(updated)
      ));
      if (conflicting) {
        const replaceable = options.replaceConflictingResource === true
          && conflicting.registryGroup === resource.registryGroup
          && conflicting.scope === resource.scope
          && conflicting.scopeKey === resource.scopeKey;
        if (!replaceable) {
          throw new Error(`权威记忆资源 "${conflicting.id}" 已引用目标来源，无法直接重新绑定。`);
        }
        recordMemoryResourceAudit(document, conflicting, 'remove', this.policy, {
          actor: options.actor ?? 'user',
          reason: `重新定位时，已将自动发现的替代登记合并到稳定资源 "${resourceId}"。`,
        });
        delete document.resources[conflicting.id];
      }
      document.resources[resourceId] = updated;
      validateMemoryResourceRegistry(document.resources);
      const audit = recordMemoryResourceAudit(document, resource, 'rebind', this.policy, {
        actor: options.actor ?? 'user',
        reason: options.reason ?? '记忆资源来源已重新定位。',
        toStatus: updated.status,
        fromSourcePath,
        toSourcePath: targetPath,
      });
      return {
        value: {
          resource: structuredClone(updated),
          changed: true,
          removed: false,
          audit: structuredClone(audit),
        },
        changed: true,
      };
    });
  }

  remove(query: MemoryResourceQuery, options: RemoveMemoryResourcesOptions = {}): Promise<number> {
    return this.documents.update((document) => {
      let removed = 0;
      for (const resource of Object.values(document.resources)) {
        if (!matchesMemoryResourceQuery(resource, query)) continue;
        if (resource.status === 'active' && options.includeActive !== true) continue;
        if (options.audit !== false && resource.scope !== 'run') {
          recordMemoryResourceAudit(document, resource, 'remove', this.policy, {
            actor: options.actor ?? 'system',
            reason: options.reason ?? '记忆资源登记已清理。',
          });
        }
        delete document.resources[resource.id];
        removed += 1;
      }
      return { value: removed, changed: removed > 0 };
    });
  }
}
