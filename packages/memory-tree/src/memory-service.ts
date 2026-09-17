// Stable runtime facade over scoped memory resource coordinators.

import { resolve } from 'node:path';
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
  MemoryAccessLedger,
  MemoryExpandOptions,
  MemoryManagementAction,
  MemoryManagementResult,
  MemoryNode,
  MemoryQueryResult,
  MemoryReleaseResult,
  MemoryResourceManagementAction,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryRunRegistration,
  MemorySearchOptions,
  MemoryWriteIntent,
  MemoryWriteResult,
} from './types.js';
import { MemoryRepository, MemoryWriteService } from './memory-repository.js';
import { MemoryResourceBranch } from './memory-resource-branch.js';
import type {
  ProjectMemoryProjectionState,
  ProjectMemoryShareableExportResult,
  ProjectMemoryTarget,
} from './project-memory-projection.js';
import { MemoryTree } from './memory-tree.js';
import {
  MemorySourceFeedbackCoordinator,
  type MemoryConversationSourceInput,
  type MemoryConversationSourceRecord,
} from './memory-service/source-feedback.js';
import type { MemoryConversationSourceBackfillInput, MemoryConversationSourceBackfillResult, MemoryConversationSourceCatalogPage, MemoryConversationSourceCatalogQuery } from './conversation-source-store.js';
import type {
  WorkspaceResourceSyncOptions,
  WorkspaceResourceSyncResult,
} from './workspace-resource-index.js';
import { AttachmentResourceCoordinator } from './memory-service/attachment-resources.js';
import { BootstrapResourceCoordinator } from './memory-service/bootstrap-resources.js';
import type {
  MemoryManagementSnapshot,
  MemoryRunResourceInput,
  MemoryRunRefinement,
  MemoryRunRefinementInput,
  MemoryRunStart,
  MemoryServiceOptions,
  MemorySkillResourceInput,
  MemorySkillSourceInput,
  SyncMemorySkillResourcesOptions,
} from './memory-service/contracts.js';
import { ProjectMemoryCoordinator } from './memory-service/project-coordinator.js';
import { MemoryResourceManagementCoordinator } from './memory-service/resource-management.js';
import { RegisteredResourceResolver } from './memory-service/resource-resolver.js';
import { MemoryRunCoordinator } from './memory-service/run-coordinator.js';
import { RuntimeEventResourceCoordinator } from './memory-service/runtime-event-resources.js';
import { SkillResourceCoordinator } from './memory-service/skill-resources.js';
import { SessionSummaryResourceCoordinator } from './memory-service/summary-resources.js';
import { WorkspaceDocumentCoordinator } from './memory-service/workspace-documents.js';
import { WorkspaceIndexResourceCoordinator } from './memory-service/workspace-index-resources.js';
import { MemoryDailyConsolidationService, type MemoryDailyConsolidationInput, type MemoryDailyConsolidationResult } from './memory-consolidation.js';

export type {
  MemoryBootstrapServiceLike,
  MemoryManagementSnapshot,
  MemoryNavigationServiceLike,
  MemoryRunResourceInput,
  MemoryRunStart,
  MemoryRunRefinement,
  MemoryRunRefinementInput,
  MemoryRunRefinementServiceLike,
  MemoryServiceOptions,
  MemorySkillResourceInput,
  MemorySkillSourceInput,
  SyncMemorySkillResourcesOptions,
} from './memory-service/contracts.js';
export {
  attachmentManifestResourceId,
  attachmentResourceId,
  runtimeEventLedgerResourceId,
} from './memory-service/resource-identifiers.js';

const MAX_T0_DIRECTORY_ENTRIES = 12;

export class MemoryService {
  private readonly tree: MemoryTree;
  private readonly repository: MemoryRepository;
  private readonly writer: MemoryWriteService;
  private readonly sourceFeedback: MemorySourceFeedbackCoordinator;
  private readonly rootIndexMaxChars: number;
  private readonly attachments: AttachmentResourceCoordinator;
  private readonly summaries: SessionSummaryResourceCoordinator;
  private readonly events: RuntimeEventResourceCoordinator;
  private readonly bootstrap: BootstrapResourceCoordinator;
  private readonly skills: SkillResourceCoordinator;
  private readonly workspaceDocuments: WorkspaceDocumentCoordinator;
  private readonly workspaceIndexes: WorkspaceIndexResourceCoordinator;
  private readonly projects: ProjectMemoryCoordinator;
  private readonly management: MemoryResourceManagementCoordinator;
  private readonly runs: MemoryRunCoordinator;
  private readonly consolidation: MemoryDailyConsolidationService;

  constructor(options: MemoryServiceOptions) {
    this.tree = options.tree;
    this.repository = options.repository;
    this.writer = options.writer;
    this.rootIndexMaxChars = options.rootIndexMaxChars;
    const dataDir = resolve(options.dataDir);
    this.sourceFeedback = new MemorySourceFeedbackCoordinator(dataDir, this.repository);
    this.attachments = new AttachmentResourceCoordinator(this.repository);
    this.summaries = new SessionSummaryResourceCoordinator(this.repository, options.resolveSessionSummary);
    this.events = new RuntimeEventResourceCoordinator(this.repository, options.resolveRuntimeEvents);
    this.bootstrap = new BootstrapResourceCoordinator(this.repository, dataDir);
    this.skills = new SkillResourceCoordinator(this.repository);
    this.workspaceDocuments = new WorkspaceDocumentCoordinator(this.repository);
    this.workspaceIndexes = new WorkspaceIndexResourceCoordinator(
      this.repository,
      dataDir,
      options.workspaceIndexLimits,
    );
    this.projects = new ProjectMemoryCoordinator(
      dataDir,
      this.repository,
      this.workspaceDocuments,
      this.workspaceIndexes,
    );
    this.management = new MemoryResourceManagementCoordinator(
      this.repository,
      this.tree,
      this.summaries,
      this.workspaceDocuments,
    );
    const resolver = new RegisteredResourceResolver(
      this.summaries,
      this.events,
      this.workspaceIndexes,
      this.attachments,
    );
    this.runs = new MemoryRunCoordinator(
      this.tree,
      this.repository,
      this.summaries,
      this.attachments,
      this.events,
      () => this.rootIndex(),
    );
    this.consolidation = new MemoryDailyConsolidationService({ repository: this.repository, writer: this.writer,
      invalidate: (branch) => this.tree.invalidateBranch(branch) });
    this.tree.register(new MemoryResourceBranch({
      repository: this.repository,
      resolve: (resource, ctx) => resolver.resolve(resource, ctx.runId, ctx.query),
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

  beginRun(input: MemoryRunRegistration): Promise<MemoryRunStart> { return this.runs.begin(input); }

  refineRun(input: MemoryRunRefinementInput): Promise<MemoryRunRefinement> { return this.runs.refine(input); }

  finishRun(runId: string): Promise<MemoryAccessLedger | undefined> { return this.runs.finish(runId); }

  branchIndex(runId: string, branchId: string): Promise<BranchIndex> { return this.tree.branchIndex(runId, branchId); }

  expand(runId: string, options: MemoryExpandOptions): Promise<MemoryQueryResult> { return this.tree.expand(runId, options); }

  deepSearch(runId: string, options: MemorySearchOptions): Promise<MemoryQueryResult> { return this.tree.deepSearch(runId, options); }

  release(runId: string, atomIds: string[]): Promise<MemoryReleaseResult> { return this.tree.release(runId, atomIds); }

  listBranches(): BranchDescription[] { return this.tree.list(); }

  listLedgers(limit = 40): MemoryAccessLedger[] { return this.tree.listLedgers(limit); }

  async invalidate(branch: string): Promise<void> {
    await this.tree.invalidateBranch(branch);
  }

  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> { return this.writer.write(intent); }
  writeMany(intents: MemoryWriteIntent[]): Promise<MemoryWriteResult[]> { return this.writer.writeMany(intents); }

  captureConversationSources(inputs: MemoryConversationSourceInput[]): Promise<MemoryConversationSourceRecord[]> { return this.sourceFeedback.capture(inputs); }
  listConversationSources(sourceRefs: string[], limit = 100): Promise<MemoryConversationSourceRecord[]> { return this.sourceFeedback.list(sourceRefs, limit); }
  async catalogConversationSources(query: MemoryConversationSourceCatalogQuery): Promise<MemoryConversationSourceCatalogPage> { return this.sourceFeedback.catalog(query); }
  async backfillConversationSources(input: MemoryConversationSourceBackfillInput): Promise<MemoryConversationSourceBackfillResult> { return this.sourceFeedback.backfill(input); }
  async conversationSourceRevocations(sourceIds: readonly string[]): Promise<{ status: 'ok' | 'unsupported'; revoked: string[] }> { return this.sourceFeedback.revocationStatus(sourceIds); }
  recordRunFeedback(input: import('./types.js').MemoryRunFeedbackInput): Promise<import('./v3/contracts.js').MemoryAtom[]> { return this.sourceFeedback.recordRunFeedback(input); }

  async recover(limit = 20): Promise<MemoryWriteResult[]> {
    const results = await this.repository.retryRecoveryQueue(limit);
    const branches = new Set(results.flatMap((result) => result.node ? [result.node.branch] : []));
    await Promise.all([...branches].map((branch) => this.tree.invalidateBranch(branch)));
    return results;
  }

  getNode(id: string): Promise<MemoryNode | undefined> { return this.repository.getNode(id); }

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

  listResources(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> { return this.management.list(query); }

  manageResource(
    resourceId: string,
    action: Extract<MemoryResourceManagementAction, 'disable' | 'restore' | 'remove'>,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.management.manage(resourceId, action, reason);
  }

  rebindResourceSource(
    resourceId: string,
    sourcePath: string,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.management.rebindSource(resourceId, sourcePath, reason);
  }

  getManagementSnapshot(): Promise<MemoryManagementSnapshot> { return this.management.snapshot(); }

  getProjectMemoryProjectionState(project: ProjectMemoryTarget): Promise<ProjectMemoryProjectionState> {
    return this.projects.getState(project);
  }

  listProjectMemoryProjectionStates(projects: ProjectMemoryTarget[]): Promise<ProjectMemoryProjectionState[]> {
    return this.projects.listStates(projects);
  }

  rebindProjectPath(
    previous: ProjectMemoryTarget,
    project: ProjectMemoryTarget,
  ): Promise<ProjectMemoryProjectionState> {
    return this.projects.rebind(previous, project);
  }

  enableProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projects.enable(project, options);
  }

  syncProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { force?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projects.sync(project, options);
  }

  disableProjectMemoryProjection(
    project: ProjectMemoryTarget,
    options: { removeProjection?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projects.disable(project, options);
  }

  exportShareableProjectMemory(
    project: ProjectMemoryTarget,
    outputPath: string,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryShareableExportResult> {
    return this.projects.exportShareable(project, outputPath, options);
  }

  registerRunResources(input: MemoryRunResourceInput): Promise<void> { return this.runs.registerResources(input); }

  registerSessionSummary(sessionId: SessionId, summary: CompactionSummary): Promise<void> { return this.summaries.register(sessionId, summary); }

  consolidateDailyMemory(input: MemoryDailyConsolidationInput): Promise<MemoryDailyConsolidationResult> {
    return this.consolidation.consolidate(input);
  }

  registerRunAttachments(runId: string, sessionId: SessionId, attachments: RunAttachment[]): Promise<void> {
    return this.attachments.register(runId, sessionId, attachments);
  }

  registerRuntimeEvents(
    runId: string,
    sessionId: SessionId,
    events: ReadonlyArray<RuntimeEventEnvelope>,
  ): Promise<void> {
    return this.events.register(runId, sessionId, events);
  }

  loadBootstrapFiles(dir: string): Promise<Record<string, string>> { return this.bootstrap.load(dir); }

  syncSkillResources(
    skills: MemorySkillResourceInput[],
    sources: MemorySkillSourceInput[],
    options: SyncMemorySkillResourcesOptions = {},
  ): Promise<void> {
    return this.skills.sync(skills, sources, options);
  }

  syncWorkspaceDocuments(workspace: string): Promise<void> { return this.workspaceDocuments.sync(workspace); }

  syncWorkspaceResources(
    workspace: string,
    options: WorkspaceResourceSyncOptions = {},
  ): Promise<WorkspaceResourceSyncResult> {
    return this.workspaceIndexes.sync(workspace, options);
  }
}
