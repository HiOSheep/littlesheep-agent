// @littlesheep/memory-tree - atomic tree document and guarded writes.

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  MemoryTreeDocument,
  MemoryWriteAuditRecord,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from './types.js';

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
    version: 1,
    updatedAt: now,
    nodes: branchRoots(now),
    recoveryQueue: [],
    writeAudit: [],
    managementAudit: [],
    migrations: {},
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

function validateDocument(value: unknown): MemoryTreeDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MemoryTreeDocument>;
  if (candidate.version !== 1 || !candidate.nodes || typeof candidate.nodes !== 'object') return null;
  if (!Array.isArray(candidate.recoveryQueue) || !Array.isArray(candidate.writeAudit)) return null;
  if (!Array.isArray(candidate.managementAudit)) candidate.managementAudit = [];
  if (!candidate.migrations || typeof candidate.migrations !== 'object') candidate.migrations = {};
  return candidate as MemoryTreeDocument;
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
      const document = await this.readDocument();
      let changed = false;
      const roots = branchRoots(document.updatedAt);
      for (const [id, node] of Object.entries(roots)) {
        if (!document.nodes[id]) {
          document.nodes[id] = node;
          changed = true;
        }
      }
      if (changed) await this.persist(document);
    });
  }

  async snapshot(): Promise<MemoryTreeDocument> {
    return this.readDocument();
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

  private async readDocument(): Promise<MemoryTreeDocument> {
    if (!existsSync(this.indexPath)) return newDocument();
    try {
      const parsed = validateDocument(JSON.parse(await readFile(this.indexPath, 'utf8')));
      if (parsed) return parsed;
      throw new Error('unsupported memory-tree document shape');
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
