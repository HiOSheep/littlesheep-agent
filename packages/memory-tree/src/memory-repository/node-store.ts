// Owns memory node queries, writes, recovery, management actions, and migration markers.

import { randomUUID } from 'node:crypto';
import { InjectionTier } from '../types.js';
import type {
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryManagementAuditRecord,
  MemoryManagementResult,
  MemoryMigrationRecord,
  MemoryNode,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import type { MemoryDocumentStore } from './document-store.js';
import { applyMemoryIntent, refreshMemoryAncestors } from './intent-writer.js';
import { cleanText } from './text.js';
import { normalizeMemoryIntent } from './write-policy.js';

export class MemoryNodeStore {
  constructor(
    private readonly documents: MemoryDocumentStore,
    private readonly policy: MemoryWritePolicy,
  ) {}

  async get(id: string): Promise<MemoryNode | undefined> {
    const node = (await this.documents.read()).nodes[id];
    return node ? structuredClone(node) : undefined;
  }

  async list(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> {
    const document = await this.documents.read();
    return Object.values(document.nodes)
      .filter((node) => node.branch === branch && !node.isBranchRoot && node.status === 'active')
      .filter((node) => !scopeKey || !node.scopeKey || node.scopeKey === scopeKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((node) => structuredClone(node));
  }

  async children(parentNodeId: string): Promise<MemoryNode[]> {
    const document = await this.documents.read();
    const parent = document.nodes[parentNodeId];
    if (!parent) return [];
    return parent.childIds
      .map((id) => document.nodes[id])
      .filter((node): node is MemoryNode => !!node && node.status === 'active')
      .map((node) => structuredClone(node));
  }

  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    return this.documents.update((document) => ({
      value: applyMemoryIntent(document, normalizeMemoryIntent(intent), this.policy),
      changed: true,
    }));
  }

  retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> {
    return this.documents.update((document) => {
      const results: MemoryWriteResult[] = [];
      const pending = document.recoveryQueue.splice(0, limit);
      for (const queued of pending) {
        if (queued.attempts >= 3) {
          document.recoveryQueue.push(queued);
          continue;
        }
        const result = applyMemoryIntent(document, queued.intent, this.policy, false);
        if (result.decision === 'queued') {
          const replacement = document.recoveryQueue.at(-1);
          if (replacement) replacement.attempts = queued.attempts + 1;
        }
        results.push(result);
      }
      return { value: results, changed: true };
    });
  }

  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    return this.documents.update((document) => {
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return { value: undefined, changed: false };
      node.status = status;
      node.updatedAt = new Date().toISOString();
      refreshMemoryAncestors(document, node.parentNodeId);
      return { value: structuredClone(node), changed: true };
    });
  }

  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    return this.documents.update((document) => {
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return { value: undefined, changed: false };
      node.tier = tier;
      node.updatedAt = new Date().toISOString();
      return { value: structuredClone(node), changed: true };
    });
  }

  manage(
    nodeId: string,
    action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.',
  ): Promise<MemoryManagementResult | undefined> {
    return this.documents.update((document) => {
      const node = document.nodes[nodeId];
      if (!node || node.isBranchRoot) return { value: undefined, changed: false };

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
      refreshMemoryAncestors(document, node.parentNodeId);
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
      return {
        value: { node: structuredClone(node), audit: structuredClone(audit) },
        changed: true,
      };
    });
  }

  async getMigration(id: string): Promise<MemoryMigrationRecord | undefined> {
    const migration = (await this.documents.read()).migrations[id];
    return migration ? structuredClone(migration) : undefined;
  }

  markMigration(record: MemoryMigrationRecord): Promise<void> {
    return this.documents.update((document) => {
      document.migrations[record.id] = structuredClone(record);
      return { value: undefined, changed: true };
    });
  }
}
