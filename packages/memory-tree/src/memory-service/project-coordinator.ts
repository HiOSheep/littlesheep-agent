// Owns project-scoped rebinding and projection lifecycle orchestration.

import type { MemoryRepository } from '../memory-repository.js';
import {
  ProjectMemoryProjectionService,
  type ProjectMemoryProjectionState,
  type ProjectMemoryShareableExportResult,
  type ProjectMemoryTarget,
} from '../project-memory-projection.js';
import type { WorkspaceResourceSyncResult } from '../workspace-resource-index.js';
import type { WorkspaceDocumentCoordinator } from './workspace-documents.js';
import type { WorkspaceIndexResourceCoordinator } from './workspace-index-resources.js';

export class ProjectMemoryCoordinator {
  private readonly projections: ProjectMemoryProjectionService;

  constructor(
    dataDir: string,
    private readonly repository: MemoryRepository,
    private readonly workspaceDocuments: WorkspaceDocumentCoordinator,
    private readonly workspaceIndexes: WorkspaceIndexResourceCoordinator,
  ) {
    this.projections = new ProjectMemoryProjectionService({ dataDir, repository });
  }

  getState(project: ProjectMemoryTarget): Promise<ProjectMemoryProjectionState> {
    return this.projections.getState(project);
  }

  listStates(projects: ProjectMemoryTarget[]): Promise<ProjectMemoryProjectionState[]> {
    return this.projections.listStates(projects);
  }

  async rebind(
    previous: ProjectMemoryTarget,
    project: ProjectMemoryTarget,
  ): Promise<ProjectMemoryProjectionState> {
    if (previous.id !== project.id) throw new Error('Project path rebind requires a stable project id.');
    await this.repository.rebindProjectPath(previous.path, project.path);
    await this.repository.replaceResourceGroup(this.workspaceDocuments.registryGroup(previous.path), [], {
      staleMode: 'remove',
    });
    await this.workspaceDocuments.sync(project.path);
    await this.workspaceIndexes.sync(project.path, {
      boundaryKind: 'project',
      projectId: project.id,
      force: true,
    });
    return this.projections.rebind(previous, project);
  }

  enable(
    project: ProjectMemoryTarget,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projections.enable(project, options);
  }

  sync(
    project: ProjectMemoryTarget,
    options: { force?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projections.sync(project, options);
  }

  disable(
    project: ProjectMemoryTarget,
    options: { removeProjection?: boolean } = {},
  ): Promise<ProjectMemoryProjectionState> {
    return this.projections.disable(project, options);
  }

  exportShareable(
    project: ProjectMemoryTarget,
    outputPath: string,
    options: { overwriteExisting?: boolean } = {},
  ): Promise<ProjectMemoryShareableExportResult> {
    return this.projections.exportShareable(project, outputPath, options);
  }
}
