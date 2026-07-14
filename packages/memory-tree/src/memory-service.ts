// Coordinates scoped memory resources and exposes the stable runtime facade.
// Storage, projection and resource lifecycles remain delegated to owned modules.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CompactionSummary,
  RunAttachment,
  RuntimeEventEnvelope,
  SessionId,
} from '@littlesheep/types';
import { InjectionTier } from './types.js';
import type {
  BranchDescription,
  BranchIndex,
  LogFn,
  MemoryAccessLedger,
  MemoryExpandOptions,
  MemoryManagementAction,
  MemoryManagementResult,
  MemoryNode,
  MemoryQueryResult,
  MemoryResourceKind,
  MemoryResourceManagementAction,
  MemoryResourceManagementResult,
  MemoryResourceOwnerKind,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryRunRegistration,
  MemorySearchOptions,
  MemoryTreeDocument,
  MemoryWriteIntent,
  MemoryWriteResult,
} from './types.js';
import { MemoryRepository, MemoryWriteService } from './memory-repository.js';
import { MemoryResourceBranch } from './memory-resource-branch.js';
import {
  ProjectMemoryProjectionService,
  type ProjectMemoryProjectionState,
  type ProjectMemoryShareableExportResult,
  type ProjectMemoryTarget,
} from './project-memory-projection.js';
import { MemoryTree } from './memory-tree.js';
import {
  WorkspaceResourceIndexStore,
  type WorkspaceResourceIndexLimits,
  type WorkspaceResourceSyncOptions,
  type WorkspaceResourceSyncResult,
} from './workspace-resource-index.js';

const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'] as const;
const PROMPT_BOOTSTRAP_FILES = new Set<string>(['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md']);
const MAX_T0_DIRECTORY_ENTRIES = 12;
const MAX_RESOLVED_RUNTIME_EVENTS = 64;
const MAX_WORKSPACE_DOCUMENTS = 64;
const MAX_WORKSPACE_DOCUMENT_DIRECTORIES = 128;
const MAX_WORKSPACE_DOCUMENT_DEPTH = 5;
const SKIPPED_WORKSPACE_DOCUMENT_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
]);

const BOOTSTRAP_KINDS: Record<(typeof BOOTSTRAP_FILES)[number], MemoryResourceKind> = {
  'AGENTS.md': 'agent-instructions',
  'SOUL.md': 'persona',
  'USER.md': 'user-profile',
  'TOOLS.md': 'tool-guidance',
  'MEMORY.md': 'legacy-memory',
};

const BOOTSTRAP_DESCRIPTIONS: Record<(typeof BOOTSTRAP_FILES)[number], string> = {
  'AGENTS.md': 'LS 的操作规则、行为边界和工程约定。',
  'SOUL.md': 'LS 的稳定人格、语气和身份偏好。',
  'USER.md': '经过确认的用户偏好、习惯和长期约束。',
  'TOOLS.md': '工具使用约定、风险和已验证经验。',
  'MEMORY.md': '兼容旧数据的长期记忆来源；新写入仍以结构化记忆树为准。',
};

export interface MemoryServiceOptions {
  tree: MemoryTree;
  repository: MemoryRepository;
  writer: MemoryWriteService;
  dataDir: string;
  rootIndexMaxChars: number;
  resolveSessionSummary?: (
    sessionId: SessionId,
    summaryId: string,
  ) => Promise<CompactionSummary | undefined>;
  resolveRuntimeEvents?: (
    runId: string,
  ) => Promise<ReadonlyArray<RuntimeEventEnvelope> | undefined>;
  workspaceIndexLimits?: Partial<WorkspaceResourceIndexLimits>;
  log?: LogFn;
}

export interface MemoryRunStart {
  rootIndex: string;
  ledger: MemoryAccessLedger;
}

export interface MemoryManagementSnapshot {
  document: MemoryTreeDocument;
  branches: BranchDescription[];
  ledgers: MemoryAccessLedger[];
  resources: MemoryResourceRegistration[];
}

export interface MemorySkillResourceInput {
  name: string;
  description: string;
  whenToUse?: string;
  dir: string;
  source: MemorySkillSourceInput;
  availability: 'active' | 'disabled' | 'shadowed';
}

export interface MemorySkillSourceInput {
  id: string;
  kind: MemoryResourceOwnerKind;
  dir: string;
  ownerId?: string;
  enabled?: boolean;
}

export interface SyncMemorySkillResourcesOptions {
  /** Only these owner kinds are reconciled; other skill owners remain untouched. */
  ownerKinds?: MemoryResourceOwnerKind[];
}

export interface MemoryRunResourceInput {
  runId: string;
  sessionId: SessionId;
  workspace: string;
  summary?: CompactionSummary;
  attachments?: RunAttachment[];
  runtimeEvents?: ReadonlyArray<RuntimeEventEnvelope>;
}

export interface MemoryNavigationServiceLike {
  rootIndex(): string | Promise<string>;
  branchIndex(runId: string, branchId: string): Promise<BranchIndex>;
  expand(runId: string, options: MemoryExpandOptions): Promise<MemoryQueryResult>;
  deepSearch(runId: string, options: MemorySearchOptions): Promise<MemoryQueryResult>;
}

export type MemoryBootstrapServiceLike = Pick<MemoryService, 'loadBootstrapFiles'>;

export function attachmentManifestResourceId(runId: string): string {
  return `attachment-manifest:${runId}`;
}

export function attachmentResourceId(runId: string, attachmentId: string): string {
  return `attachment:${runId}:${attachmentId}`;
}

export function runtimeEventLedgerResourceId(runId: string): string {
  return `runtime-events:${runId}`;
}

function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/u, '').toLocaleLowerCase();
}

function fileResourceId(path: string): string {
  return `file:${hashId(normalizedPath(path))}`;
}

function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function documentKind(fileName: string): MemoryResourceKind {
  const lower = fileName.toLocaleLowerCase();
  if (lower.includes('ui') && /(guideline|规范)/u.test(lower)) return 'ui-guideline';
  if (/(taskbook|任务书)/u.test(lower)) return 'taskbook';
  if (/(principle|guideline|architecture|规范|原则)/u.test(lower)) return 'project-guideline';
  return 'knowledge';
}

function isWorkspaceDocument(fileName: string): boolean {
  const lower = fileName.toLocaleLowerCase();
  return lower === 'readme.md'
    || /(taskbook|guideline|principle|architecture|任务书|规范|原则)/u.test(lower);
}

export class MemoryService {
  private readonly tree: MemoryTree;
  private readonly repository: MemoryRepository;
  private readonly writer: MemoryWriteService;
  private readonly dataDir: string;
  private readonly rootIndexMaxChars: number;
  private readonly resolveSessionSummary?: MemoryServiceOptions['resolveSessionSummary'];
  private readonly resolveRuntimeEvents?: MemoryServiceOptions['resolveRuntimeEvents'];
  private readonly activeRunAttachments = new Map<string, Map<string, RunAttachment>>();
  private readonly projectMemoryProjections: ProjectMemoryProjectionService;
  private readonly workspaceResourceIndexes: WorkspaceResourceIndexStore;
  private readonly workspaceSyncQueues = new Map<string, Promise<void>>();

  constructor(options: MemoryServiceOptions) {
    this.tree = options.tree;
    this.repository = options.repository;
    this.writer = options.writer;
    this.dataDir = resolve(options.dataDir);
    this.rootIndexMaxChars = options.rootIndexMaxChars;
    this.resolveSessionSummary = options.resolveSessionSummary;
    this.resolveRuntimeEvents = options.resolveRuntimeEvents;
    this.projectMemoryProjections = new ProjectMemoryProjectionService({
      dataDir: this.dataDir,
      repository: this.repository,
    });
    this.workspaceResourceIndexes = new WorkspaceResourceIndexStore({
      dataDir: this.dataDir,
      limits: options.workspaceIndexLimits,
    });
    this.tree.register(new MemoryResourceBranch({
      repository: this.repository,
      resolve: (resource, ctx) => this.resolveResourceContent(resource, ctx.runId, ctx.query),
    }));
  }

  async rootIndex(): Promise<string> {
    const t0Resources = (await this.repository.listResources({
      tier: InjectionTier.T0_CORE,
      status: 'active',
    })).slice(0, MAX_T0_DIRECTORY_ENTRIES);
    const resourceLines = t0Resources.map((resource) => (
      `- [${resource.id}] ${resource.title}: ${resource.kind}; authority=${resource.authority}; body is not preloaded.`
    ));
    const directory = resourceLines.length > 0
      ? [
          '',
          'T0 registered resources (metadata only):',
          ...resourceLines,
          'Use the `resources` branch index before expanding any registered body.',
        ].join('\n')
      : '';
    const treeBudget = Math.max(600, this.rootIndexMaxChars - directory.length);
    const base = this.tree.rootIndex(treeBudget);
    const combined = `${base}${directory}`;
    if (combined.length <= this.rootIndexMaxChars) return combined;
    const marker = '\n... [T0 root index bounded]';
    return combined.slice(0, Math.max(0, this.rootIndexMaxChars - marker.length)) + marker;
  }

  async beginRun(input: MemoryRunRegistration): Promise<MemoryRunStart> {
    const rootIndex = input.rootIndex ?? await this.rootIndex();
    const t0Count = (await this.repository.listResources({
      tier: InjectionTier.T0_CORE,
      status: 'active',
    })).length;
    const ledger = this.tree.beginRun({
      ...input,
      rootIndex,
      rootSourceCount: input.rootSourceCount ?? this.tree.list().length + t0Count,
    });
    return { rootIndex, ledger };
  }

  async finishRun(runId: string): Promise<MemoryAccessLedger | undefined> {
    this.activeRunAttachments.delete(runId);
    const ledger = this.tree.finishRun(runId);
    const resources = await this.repository.listResources({ scope: 'run', scopeKey: runId });
    await Promise.all(resources.map((resource) => this.repository.manageResource(
      resource.id,
      'mark-missing',
      {
        actor: 'system',
        reason: '运行结束后，运行级资源正文已失效；元数据继续保留用于关联执行证据。',
        audit: false,
      },
    )));
    return ledger;
  }

  branchIndex(runId: string, branchId: string): Promise<BranchIndex> {
    return this.tree.branchIndex(runId, branchId);
  }

  expand(runId: string, options: MemoryExpandOptions): Promise<MemoryQueryResult> {
    return this.tree.expand(runId, options);
  }

  deepSearch(runId: string, options: MemorySearchOptions): Promise<MemoryQueryResult> {
    return this.tree.deepSearch(runId, options);
  }

  listBranches(): BranchDescription[] {
    return this.tree.list();
  }

  listLedgers(limit = 40): MemoryAccessLedger[] {
    return this.tree.listLedgers(limit);
  }

  async invalidate(branch: string): Promise<void> {
    await this.tree.invalidateBranch(branch);
  }

  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    return this.writer.write(intent);
  }

  writeMany(intents: MemoryWriteIntent[]): Promise<MemoryWriteResult[]> {
    return this.writer.writeMany(intents);
  }

  async recover(limit = 20): Promise<MemoryWriteResult[]> {
    const results = await this.repository.retryRecoveryQueue(limit);
    const branches = new Set(results.flatMap((result) => result.node ? [result.node.branch] : []));
    await Promise.all([...branches].map((branch) => this.tree.invalidateBranch(branch)));
    return results;
  }

  getNode(id: string): Promise<MemoryNode | undefined> {
    return this.repository.getNode(id);
  }

  async manageNode(
    nodeId: string,
    action: MemoryManagementAction,
    reason?: string,
  ): Promise<MemoryManagementResult | undefined> {
    const existing = await this.repository.getNode(nodeId);
    if (!existing || existing.isBranchRoot) return undefined;
    const result = await this.repository.manageNode(nodeId, action, reason);
    if (result) await this.tree.invalidateBranch(existing.branch);
    return result;
  }

  listResources(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    return this.repository.listResources(query);
  }

  async manageResource(
    resourceId: string,
    action: Extract<MemoryResourceManagementAction, 'disable' | 'restore' | 'remove'>,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    const resource = await this.repository.getResource(resourceId);
    if (!resource) return undefined;
    this.assertUserManageableResource(resource);

    if (action === 'restore') {
      const observedStatus = await this.observeResourceStatus(resource);
      if (observedStatus !== 'active') {
        throw new Error('资源来源仍不可用，请先恢复来源或重新定位资源。');
      }
      return this.repository.manageResource(resourceId, action, {
        actor: 'user',
        reason: reason ?? '用户恢复了已登记的记忆资源。',
        restoreStatus: observedStatus,
      });
    }
    return this.repository.manageResource(resourceId, action, {
      actor: 'user',
      reason: reason ?? (action === 'disable'
        ? '用户停用了已登记的记忆资源。'
        : '用户移除了非活动记忆资源的登记，来源文件未被删除。'),
    });
  }

  async rebindResourceSource(
    resourceId: string,
    sourcePath: string,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    const resource = await this.repository.getResource(resourceId);
    if (!resource) return undefined;
    this.assertUserManageableResource(resource);
    if (resource.source.kind !== 'file' || !resource.registryGroup.startsWith('workspace-docs:')) {
      throw new Error('此控制面只能重新定位已登记的工作区文档。');
    }
    if (resource.scope !== 'workspace' || !resource.scopeKey) {
      throw new Error('该资源没有已授权的工作区边界。');
    }

    const target = resolve(sourcePath);
    if (!pathInsideOrSame(resource.scopeKey, target)) {
      throw new Error('重新定位后的资源必须保留在其已授权工作区内。');
    }
    if (!target.toLocaleLowerCase().endsWith('.md') || !isWorkspaceDocument(basename(target))) {
      throw new Error('所选文件不是受支持的工作区规范、任务书、架构文档或 README。');
    }
    const targetStat = await stat(target).catch(() => undefined);
    if (!targetStat?.isFile()) throw new Error('所选资源文件不存在。');
    const body = await readFile(target, 'utf8');
    const kind = documentKind(basename(target));
    const rebound = await this.repository.rebindResource(resourceId, {
      sourcePath: target,
      title: basename(target),
      kind,
      indexKeys: [basename(target), kind, basename(resource.scopeKey)],
      contentHash: contentHash(body),
      status: 'active',
    }, {
      actor: 'user',
      reason: reason ?? '资源来源移动或重命名后，用户重新定位了工作区记忆资源。',
      replaceConflictingResource: true,
    });
    await this.syncWorkspaceDocuments(resource.scopeKey);
    return rebound;
  }

  async getManagementSnapshot(): Promise<MemoryManagementSnapshot> {
    const [document, resources] = await Promise.all([
      this.repository.snapshot(),
      this.repository.listResources(),
    ]);
    return {
      document,
      branches: this.tree.list(),
      ledgers: this.tree.listLedgers(80),
      resources,
    };
  }

  getProjectMemoryProjectionState(project: ProjectMemoryTarget): Promise<ProjectMemoryProjectionState> {
    return this.projectMemoryProjections.getState(project);
  }

  listProjectMemoryProjectionStates(
    projects: ProjectMemoryTarget[],
  ): Promise<ProjectMemoryProjectionState[]> {
    return this.projectMemoryProjections.listStates(projects);
  }

  async rebindProjectPath(
    previous: ProjectMemoryTarget,
    project: ProjectMemoryTarget,
  ): Promise<ProjectMemoryProjectionState> {
    if (previous.id !== project.id) throw new Error('Project path rebind requires a stable project id.');
    await this.repository.rebindProjectPath(previous.path, project.path);
    await this.repository.replaceResourceGroup(workspaceDocumentRegistryGroup(previous.path), [], { staleMode: 'remove' });
    await this.syncWorkspaceDocuments(project.path);
    await this.syncWorkspaceResources(project.path, {
      boundaryKind: 'project',
      projectId: project.id,
      force: true,
    });
    return this.projectMemoryProjections.rebind(previous, project);
  }

  enableProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projectMemoryProjections.enable(project, options);
  }

  syncProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { force?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projectMemoryProjections.sync(project, options);
  }

  disableProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { removeProjection?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projectMemoryProjections.disable(project, options);
  }

  exportShareableProjectMemory(
    project: ProjectMemoryTarget,
    outputPath: string,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryShareableExportResult> {
    return this.projectMemoryProjections.exportShareable(project, outputPath, options);
  }

  async registerRunResources(input: MemoryRunResourceInput): Promise<void> {
    if (input.summary) await this.registerSessionSummary(input.sessionId, input.summary);
    await this.registerRunAttachments(input.runId, input.sessionId, input.attachments ?? []);
    await this.registerRuntimeEvents(input.runId, input.sessionId, input.runtimeEvents ?? []);
  }

  async registerSessionSummary(sessionId: SessionId, summary: CompactionSummary): Promise<void> {
    const resource: MemoryResourceRegistration = {
      version: 1,
      id: summary.id,
      kind: 'summary-memory',
      title: '会话摘要',
      description: `覆盖 ${summary.collapsedCount} 条历史消息的版本化摘要。`,
      tier: InjectionTier.T1_ESSENTIAL,
      scope: 'session',
      scopeKey: String(sessionId),
      authority: 'derived',
      privacy: 'private',
      source: { kind: 'session-summary', id: summary.id },
      indexKeys: [
        'summary memory',
        '会话摘要',
        summary.sourceStartMessageId,
        summary.sourceEndMessageId,
      ],
      status: 'active',
      registryGroup: `session-summary:${sessionId}`,
      registeredAt: summary.compactedAt,
      updatedAt: summary.compactedAt,
      metadata: {
        sessionId: String(sessionId),
        collapsedCount: summary.collapsedCount,
        sourceStartMessageId: summary.sourceStartMessageId,
        sourceEndMessageId: summary.sourceEndMessageId,
        sourceStartAt: summary.sourceStartAt,
        sourceEndAt: summary.sourceEndAt,
        previousSummaryId: summary.previousSummaryId,
        model: summary.model,
      },
    };
    await this.repository.replaceResourceGroup(resource.registryGroup, [resource], { staleMode: 'remove' });
  }

  async registerRunAttachments(
    runId: string,
    sessionId: SessionId,
    attachments: RunAttachment[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const group = `session-attachments:${sessionId}`;
    const resources: MemoryResourceRegistration[] = [];
    const active = new Map<string, RunAttachment>();

    if (attachments.length > 0) {
      resources.push({
        version: 1,
        id: attachmentManifestResourceId(runId),
        kind: 'attachment-manifest',
        title: '本轮附件清单',
        description: `本轮共有 ${attachments.length} 个附件；清单不包含文件正文。`,
        tier: InjectionTier.T1_ESSENTIAL,
        scope: 'run',
        scopeKey: runId,
        authority: 'external',
        privacy: 'private',
        source: { kind: 'attachment', id: attachmentManifestResourceId(runId) },
        indexKeys: ['attachment manifest', '附件清单', runId],
        status: 'active',
        registryGroup: group,
        registeredAt: now,
        updatedAt: now,
        metadata: { runId, sessionId: String(sessionId), attachmentCount: attachments.length },
      });
    }

    attachments.forEach((attachment, index) => {
      const attachmentId = attachment.id ?? `attachment-${index + 1}`;
      const resourceId = attachmentResourceId(runId, attachmentId);
      active.set(resourceId, { ...attachment, id: attachmentId, dataUrl: undefined });
      resources.push({
        version: 1,
        id: resourceId,
        kind: 'attachment',
        title: attachment.name ?? basename(attachment.path),
        description: '用户为本轮任务提供的附件；正文仅在任务确有需要时通过专用读取路径解析。',
        tier: InjectionTier.T2_RELEVANT,
        scope: 'run',
        scopeKey: runId,
        authority: 'external',
        privacy: attachment.ownership === 'project' ? 'project-private' : 'private',
        source: { kind: 'attachment', id: attachmentId, path: attachment.path },
        indexKeys: [attachmentId, attachment.name ?? basename(attachment.path), attachment.kind, attachment.mimeType ?? ''],
        status: 'active',
        registryGroup: group,
        registeredAt: now,
        updatedAt: now,
        metadata: {
          runId,
          sessionId: String(sessionId),
          attachmentId,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          size: attachment.size,
          contentHash: attachment.contentHash,
          ownership: attachment.ownership ?? 'external',
          contentState: attachment.contentState ?? 'uninspected',
          extractionNote: attachment.extractionNote,
        },
      });
    });

    if (active.size > 0) this.activeRunAttachments.set(runId, active);
    else this.activeRunAttachments.delete(runId);
    await this.repository.replaceResourceGroup(group, resources, { staleMode: 'remove' });
  }

  async registerRuntimeEvents(
    runId: string,
    sessionId: SessionId,
    events: ReadonlyArray<RuntimeEventEnvelope>,
  ): Promise<void> {
    const group = `session-runtime-events:${sessionId}`;
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    for (const event of events) {
      if (event.runId !== runId || String(event.sessionId) !== String(sessionId)) {
        throw new Error(`Runtime event "${event.id}" does not belong to run "${runId}" and its session.`);
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
        throw new Error(`Runtime event "${event.id}" has an invalid sequence.`);
      }
      if (eventIds.has(event.id)) throw new Error(`Duplicate runtime event id "${event.id}".`);
      if (sequences.has(event.sequence)) throw new Error(`Duplicate runtime event sequence ${event.sequence}.`);
      eventIds.add(event.id);
      sequences.add(event.sequence);
    }
    const valid = [...events].sort((left, right) => left.sequence - right.sequence);
    if (valid.length === 0) {
      await this.repository.replaceResourceGroup(group, [], { staleMode: 'remove' });
      return;
    }
    const now = new Date().toISOString();
    const eventTypes = [...new Set(valid.map((event) => event.type))];
    const statusCounts = Object.fromEntries(
      [...new Set(valid.map((event) => event.status))]
        .map((status) => [status, valid.filter((event) => event.status === status).length]),
    );
    const resourceId = runtimeEventLedgerResourceId(runId);
    const resource: MemoryResourceRegistration = {
      version: 1,
      id: resourceId,
      kind: 'runtime-event-ledger',
      title: '本轮运行时事件账本',
      description: `登记 ${valid.length} 个运行时事件的状态与顺序；不复制事件 payload。`,
      tier: InjectionTier.T2_RELEVANT,
      scope: 'run',
      scopeKey: runId,
      authority: 'derived',
      privacy: 'private',
      source: { kind: 'runtime-event', id: resourceId },
      indexKeys: ['runtime events', '运行时事件', runId, ...eventTypes],
      status: 'active',
      registryGroup: group,
      registeredAt: now,
      updatedAt: now,
      metadata: {
        runId,
        sessionId: String(sessionId),
        eventCount: valid.length,
        eventTypes,
        statusCounts,
        firstSequence: valid[0]!.sequence,
        latestSequence: valid.at(-1)!.sequence,
        firstReceivedAt: valid[0]!.receivedAt,
        latestReceivedAt: valid.at(-1)!.receivedAt,
      },
    };
    await this.repository.replaceResourceGroup(group, [resource], { staleMode: 'remove' });
  }

  private async resolveResourceContent(
    resource: MemoryResourceRegistration,
    runId: string,
    query?: string,
  ): Promise<{ content: string; source: string; generatedAt?: string } | undefined> {
    if (resource.source.kind === 'session-summary' && resource.source.id && resource.scopeKey) {
      const summary = await this.resolveSessionSummary?.(resource.scopeKey as SessionId, resource.source.id);
      if (!summary || summary.id !== resource.id) return undefined;
      return {
        content: summary.summary,
        source: `session:${resource.scopeKey}#summary:${summary.id}`,
        generatedAt: summary.compactedAt,
      };
    }
    if (resource.source.kind === 'runtime-event' && resource.scopeKey) {
      const events = (await this.resolveRuntimeEvents?.(resource.scopeKey))
        ?.filter((event) => event.runId === resource.scopeKey)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-MAX_RESOLVED_RUNTIME_EVENTS);
      if (!events || events.length === 0) return undefined;
      const expectedSessionId = typeof resource.metadata?.sessionId === 'string'
        ? resource.metadata.sessionId
        : undefined;
      const valid = expectedSessionId
        ? events.filter((event) => String(event.sessionId) === expectedSessionId)
        : events;
      if (valid.length === 0) return undefined;
      return {
        content: [
          'Runtime event ledger (payload values are intentionally omitted):',
          ...valid.map((event) => [
            `- #${event.sequence} ${event.type}; status=${event.status}; source=${event.source}; received=${event.receivedAt}`,
            `payload keys=${Object.keys(event.payload).slice(0, 20).join(', ') || 'none'}`,
            event.appliedAt ? `applied=${event.appliedAt}` : '',
            event.expiresAt ? `expires=${event.expiresAt}` : '',
            event.decisionReason ? 'decision reason recorded' : '',
          ].filter(Boolean).join('; ')),
        ].join('\n'),
        source: `run:${resource.scopeKey}#runtime-events`,
        generatedAt: valid.at(-1)!.receivedAt,
      };
    }
    if (resource.source.kind === 'workspace-index' && resource.source.path) {
      const content = await this.workspaceResourceIndexes.render(resource.source.path, query);
      if (!content) return undefined;
      return {
        content,
        source: `workspace:${resource.scopeKey ?? resource.source.id ?? 'unknown'}#resource-index`,
        generatedAt: resource.updatedAt,
      };
    }
    if (resource.source.kind !== 'attachment') return undefined;
    const attachments = this.activeRunAttachments.get(runId);
    if (!attachments) return undefined;
    if (resource.kind === 'attachment-manifest') {
      const entries = [...attachments.values()];
      return {
        content: [
          'Attached files manifest (file bodies are not included):',
          ...entries.map((attachment) => (
            `- [${attachment.id}] ${attachment.name ?? attachment.path} (${attachment.kind}, ${attachment.size ?? 'unknown'} bytes, ${attachment.contentState ?? 'uninspected'})`
          )),
          'Use the run-scoped inspect_attachment tool when a non-image body is required.',
        ].join('\n'),
        source: `run:${runId}#attachments`,
      };
    }
    const attachment = attachments.get(resource.id);
    if (!attachment) return undefined;
    const content = attachment.extractedText?.trim()
      ? attachment.extractedText
      : [
          `Attachment: ${attachment.name ?? attachment.path}`,
          `Kind: ${attachment.kind}; content state: ${attachment.contentState ?? 'uninspected'}.`,
          attachment.kind === 'image'
            ? 'Image bytes are handled by the model input path and are not duplicated into the memory registry.'
            : `Use inspect_attachment with attachment_id=${attachment.id} to parse the body only when needed.`,
          attachment.extractionNote ?? '',
        ].filter(Boolean).join('\n');
    return { content, source: attachment.path };
  }

  async loadBootstrapFiles(dir: string): Promise<Record<string, string>> {
    const root = resolve(dir);
    const isGlobal = normalizedPath(root) === normalizedPath(this.dataDir);
    const now = new Date().toISOString();
    const resources: MemoryResourceRegistration[] = [];
    const output: Record<string, string> = {};

    for (const fileName of BOOTSTRAP_FILES) {
      const path = join(root, fileName);
      let content: string | undefined;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        content = undefined;
      }
      const kind = BOOTSTRAP_KINDS[fileName];
      const tier = isGlobal && (fileName === 'AGENTS.md' || fileName === 'SOUL.md')
        ? InjectionTier.T0_CORE
        : isGlobal
          ? InjectionTier.T1_ESSENTIAL
          : fileName === 'AGENTS.md'
            ? InjectionTier.T1_ESSENTIAL
            : InjectionTier.T2_RELEVANT;
      resources.push({
        version: 1,
        id: fileResourceId(path),
        kind,
        title: fileName,
        description: BOOTSTRAP_DESCRIPTIONS[fileName],
        tier,
        branch: kind === 'legacy-memory' ? 'long-term' : undefined,
        scope: isGlobal ? 'global' : 'workspace',
        scopeKey: isGlobal ? undefined : root,
        authority: kind === 'legacy-memory' ? 'compatibility' : 'authoritative',
        privacy: isGlobal ? 'private' : 'project-private',
        source: {
          kind: 'file',
          path,
          contentHash: content === undefined ? undefined : contentHash(content),
        },
        indexKeys: [fileName, kind, basename(root)],
        status: content === undefined ? 'missing' : 'active',
        registryGroup: `bootstrap:${hashId(normalizedPath(root))}`,
        registeredAt: now,
        updatedAt: now,
      });
      if (content !== undefined && PROMPT_BOOTSTRAP_FILES.has(fileName)) output[fileName] = content;
    }
    await this.repository.replaceResourceGroup(resources[0]!.registryGroup, resources);
    return output;
  }

  async syncSkillResources(
    skills: MemorySkillResourceInput[],
    sources: MemorySkillSourceInput[],
    options: SyncMemorySkillResourcesOptions = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    const managedKinds = new Set(options.ownerKinds ?? sources.map((source) => source.kind));
    const managedSources = sources.filter((source) => managedKinds.has(source.kind));
    const existing = await this.repository.listResources({ kind: 'skill' });
    const existingByPath = new Map(existing
      .filter((resource) => resource.source.path)
      .map((resource) => [normalizedPath(resource.source.path!), resource]));
    const existingByOwnerAndName = new Map(existing
      .filter((resource) => resource.owner && typeof resource.metadata?.skillName === 'string')
      .map((resource) => [
        skillOwnerKey(resource.owner!.kind, resource.owner!.id, String(resource.metadata!.skillName)),
        resource,
      ]));
    const currentGroups = new Set<string>();

    for (const source of managedSources) {
      const ownerId = source.ownerId ?? source.id;
      const registryGroup = skillRegistryGroup(source.kind, ownerId);
      currentGroups.add(registryGroup);
      const sourceSkills = skills.filter((skill) => skill.source.id === source.id);
      const resources: MemoryResourceRegistration[] = [];
      for (const skill of sourceSkills) {
        const path = join(skill.dir, 'SKILL.md');
        const ownerKey = skillOwnerKey(source.kind, ownerId, skill.name);
        const prior = existingByOwnerAndName.get(ownerKey) ?? existingByPath.get(normalizedPath(path));
        let fileUpdatedAt = now;
        let status: MemoryResourceRegistration['status'] = skill.availability === 'active'
          ? 'active'
          : skill.availability === 'disabled'
            ? 'disabled'
            : 'conflict';
        try {
          fileUpdatedAt = (await stat(path)).mtime.toISOString();
        } catch {
          status = 'missing';
        }
        if (prior?.source.path && normalizedPath(prior.source.path) !== normalizedPath(path)) {
          await this.repository.rebindResource(prior.id, {
            sourcePath: path,
            title: skill.name,
            kind: 'skill',
            indexKeys: [skill.name, skill.description, skill.whenToUse ?? ''],
            status: status === 'disabled' ? 'active' : status,
          }, {
            actor: 'system',
            reason: `技能“${skill.name}”随其所有者迁移了来源路径。`,
            replaceConflictingResource: true,
          });
        }
        resources.push({
          version: 1,
          id: prior?.id ?? `skill:${hashId(`${source.kind}:${ownerId}:${skill.name}`)}`,
          kind: 'skill',
          title: skill.name,
          description: skill.description,
          tier: InjectionTier.T2_RELEVANT,
          scope: 'global',
          authority: 'authoritative',
          privacy: 'private',
          source: { kind: 'file', path },
          indexKeys: [skill.name, skill.description, skill.whenToUse ?? ''],
          status,
          registryGroup,
          owner: {
            kind: source.kind,
            id: ownerId,
            controller: source.kind === 'plugin' ? 'plugin-host' : 'skill-loader',
          },
          registeredAt: prior?.registeredAt ?? now,
          updatedAt: fileUpdatedAt,
          metadata: {
            ...prior?.metadata,
            skillName: skill.name,
            skillAvailability: skill.availability,
            skillSourceId: source.id,
          },
        });
      }
      await this.repository.replaceResourceGroup(registryGroup, resources, {
        preserveDisabled: false,
        reason: source.kind === 'plugin'
          ? `插件“${ownerId}”已同步其 Skill 生命周期。`
          : `SkillLoader 已同步来源“${ownerId}”。`,
      });
    }

    const managesLegacySkillGroup = [...managedKinds].some((kind) => kind !== 'plugin');
    const staleGroups = new Set(existing
      .filter((resource) => resource.owner
        ? managedKinds.has(resource.owner.kind)
        : managesLegacySkillGroup)
      .map((resource) => resource.registryGroup)
      .filter((group) => !currentGroups.has(group)));
    for (const group of staleGroups) {
      await this.repository.replaceResourceGroup(group, [], {
        preserveDisabled: false,
        reason: 'Skill 所有者已不再被发现，资源登记保留为来源缺失状态。',
      });
    }
  }

  async syncWorkspaceDocuments(workspace: string): Promise<void> {
    const root = resolve(workspace);
    const group = workspaceDocumentRegistryGroup(root);
    const existing = await this.repository.listResources({ registryGroup: group });
    const existingByPath = new Map(existing
      .filter((resource) => resource.source.path)
      .map((resource) => [normalizedPath(resource.source.path!), resource]));
    const candidates = new Set<string>();
    const readDirectory = async (dir: string, recursive: boolean): Promise<void> => {
      const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
      let visited = 0;
      while (queue.length > 0
        && candidates.size < MAX_WORKSPACE_DOCUMENTS
        && visited < MAX_WORKSPACE_DOCUMENT_DIRECTORIES) {
        const current = queue.shift()!;
        visited += 1;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await readdir(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md') && isWorkspaceDocument(entry.name)) {
            candidates.add(join(current.dir, entry.name));
            if (candidates.size >= MAX_WORKSPACE_DOCUMENTS) break;
            continue;
          }
          if (!recursive || !entry.isDirectory() || current.depth >= MAX_WORKSPACE_DOCUMENT_DEPTH) continue;
          const lower = entry.name.toLocaleLowerCase();
          if (entry.name.startsWith('.') || SKIPPED_WORKSPACE_DOCUMENT_DIRS.has(lower)) continue;
          queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    };
    await readDirectory(root, false);
    if (candidates.size < MAX_WORKSPACE_DOCUMENTS) await readDirectory(join(root, 'docs'), true);

    const now = new Date().toISOString();
    const resources: MemoryResourceRegistration[] = [];
    for (const path of [...candidates].slice(0, MAX_WORKSPACE_DOCUMENTS)) {
      const prior = existingByPath.get(normalizedPath(path));
      let fileUpdatedAt = now;
      let status: MemoryResourceRegistration['status'] = 'active';
      try {
        fileUpdatedAt = (await stat(path)).mtime.toISOString();
      } catch {
        status = 'missing';
      }
      const kind = documentKind(basename(path));
      const relativeTitle = relative(root, path).replace(/[\\/]+/g, '/');
      const displayTitle = relativeTitle.split('/').length <= 2 ? basename(path) : relativeTitle;
      resources.push({
        version: 1,
        id: prior?.id ?? fileResourceId(path),
        kind,
        title: displayTitle,
        description: '工作区正式文档已登记为索引资源，正文不会默认常驻上下文。',
        tier: kind === 'project-guideline' ? InjectionTier.T1_ESSENTIAL : InjectionTier.T2_RELEVANT,
        branch: 'project',
        scope: 'workspace',
        scopeKey: root,
        authority: 'authoritative',
        privacy: 'project-private',
        source: { kind: 'file', path },
        indexKeys: [relativeTitle, basename(path), kind, basename(root)],
        status,
        registryGroup: workspaceDocumentRegistryGroup(root),
        registeredAt: now,
        updatedAt: fileUpdatedAt,
      });
    }
    await this.repository.replaceResourceGroup(group, resources);
  }

  async syncWorkspaceResources(
    workspace: string,
    options: WorkspaceResourceSyncOptions = {},
  ): Promise<WorkspaceResourceSyncResult> {
    const key = options.projectId?.trim()
      ? `project:${options.projectId.trim()}`
      : normalizedPath(workspace);
    return this.serializeWorkspaceSync(key, () => this.syncWorkspaceResourcesUnlocked(workspace, options));
  }

  private async syncWorkspaceResourcesUnlocked(
    workspace: string,
    options: WorkspaceResourceSyncOptions,
  ): Promise<WorkspaceResourceSyncResult> {
    const result = await this.workspaceResourceIndexes.sync(workspace, options);
    const snapshot = result.snapshot;
    const group = workspaceIndexRegistryGroup(snapshot.identity);
    const existing = await this.repository.listResources({ registryGroup: group });
    const prior = existing.find((resource) => resource.kind === 'workspace-index');
    const rootName = basename(snapshot.workspacePath) || snapshot.workspacePath;
    const status = snapshot.scan.status === 'missing' ? 'missing' : 'active';
    if (!result.changed
      && prior
      && prior.status === status
      && prior.scopeKey
      && normalizedPath(prior.scopeKey) === normalizedPath(snapshot.workspacePath)) {
      return result;
    }
    const resource: MemoryResourceRegistration = {
      version: 1,
      id: prior?.id ?? `workspace-index:${hashId(snapshot.identity)}`,
      kind: 'workspace-index',
      title: `工作区资源索引：${rootName}`,
      description: `登记 ${snapshot.files.length} 个文件的路径与元数据；文件正文不会因建立索引而进入上下文。`,
      tier: InjectionTier.T2_RELEVANT,
      branch: 'project',
      scope: 'workspace',
      scopeKey: snapshot.workspacePath,
      authority: 'derived',
      privacy: snapshot.boundaryKind === 'project' ? 'project-private' : 'private',
      source: {
        kind: 'workspace-index',
        id: snapshot.identity,
        path: result.indexPath,
      },
      indexKeys: [
        'workspace index',
        '工作区文件索引',
        rootName,
        snapshot.boundaryKind,
        ...snapshot.files.slice(0, 24).map((file) => file.relativePath),
      ],
      status,
      registryGroup: group,
      registeredAt: prior?.registeredAt ?? snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
      metadata: {
        workspacePath: snapshot.workspacePath,
        boundaryKind: snapshot.boundaryKind,
        projectId: snapshot.projectId,
        fileCount: snapshot.files.length,
        scanStatus: snapshot.scan.status,
        scanGeneration: snapshot.scan.generation,
        truncated: snapshot.scan.truncated,
        completedAt: snapshot.scan.completedAt,
      },
    };
    await this.repository.replaceResourceGroup(group, [resource], {
      preserveDisabled: false,
      staleMode: 'remove',
      reason: '工作区资源索引已按有界扫描结果同步。',
    });
    return result;
  }

  private serializeWorkspaceSync<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.workspaceSyncQueues.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.workspaceSyncQueues.set(key, settled);
    void settled.then(() => {
      if (this.workspaceSyncQueues.get(key) === settled) this.workspaceSyncQueues.delete(key);
    });
    return result;
  }

  private assertUserManageableResource(resource: MemoryResourceRegistration): void {
    if (resource.scope === 'run') {
      throw new Error('Run-scoped resources are managed automatically and expire when the run finishes.');
    }
    if (resource.kind === 'project-memory-projection') {
      throw new Error('Use the project memory projection controls for this resource.');
    }
    if (resource.kind === 'workspace-index') {
      throw new Error('工作区资源索引由运行时自动维护，不能从记忆资源控制面修改。');
    }
    if (resource.owner?.controller === 'plugin-host') {
      throw new Error('该 Skill 由插件宿主管理，请在插件页面更改其状态。');
    }
    if (resource.owner?.controller === 'skill-loader') {
      throw new Error('该 Skill 由技能配置管理，请在技能页面更改其状态。');
    }
  }

  private async observeResourceStatus(
    resource: MemoryResourceRegistration,
  ): Promise<Extract<MemoryResourceRegistration['status'], 'active' | 'missing'>> {
    if (resource.source.kind === 'file') {
      const sourcePath = resource.source.path;
      if (!sourcePath) return 'missing';
      const sourceStat = await stat(sourcePath).catch(() => undefined);
      return sourceStat?.isFile() ? 'active' : 'missing';
    }
    if (resource.source.kind === 'session-summary' && resource.source.id && resource.scopeKey) {
      const summary = await this.resolveSessionSummary?.(resource.scopeKey as SessionId, resource.source.id);
      return summary?.id === resource.id ? 'active' : 'missing';
    }
    return 'missing';
  }
}

function workspaceDocumentRegistryGroup(root: string): string {
  return `workspace-docs:${hashId(normalizedPath(root))}`;
}

function workspaceIndexRegistryGroup(identity: string): string {
  return `workspace-index:${hashId(identity)}`;
}

function skillRegistryGroup(kind: MemoryResourceOwnerKind, ownerId: string): string {
  return kind === 'plugin'
    ? `skills:plugin:${ownerId}`
    : `skills:${kind}:${hashId(ownerId)}`;
}

function skillOwnerKey(kind: MemoryResourceOwnerKind, ownerId: string, skillName: string): string {
  return `${kind}:${ownerId}:${skillName}`.toLocaleLowerCase();
}

function pathInsideOrSame(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
