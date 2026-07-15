import type { MemoryResourceRegistration } from '../types.js';
import type { AttachmentResourceCoordinator } from './attachment-resources.js';
import type { RuntimeEventResourceCoordinator } from './runtime-event-resources.js';
import type { SessionSummaryResourceCoordinator } from './summary-resources.js';
import type { WorkspaceIndexResourceCoordinator } from './workspace-index-resources.js';

export interface ResolvedRegisteredResource {
  content: string;
  source: string;
  generatedAt?: string;
}

export class RegisteredResourceResolver {
  constructor(
    private readonly summaries: SessionSummaryResourceCoordinator,
    private readonly events: RuntimeEventResourceCoordinator,
    private readonly workspaceIndexes: WorkspaceIndexResourceCoordinator,
    private readonly attachments: AttachmentResourceCoordinator,
  ) {}

  async resolve(
    resource: MemoryResourceRegistration,
    runId: string,
    query?: string,
  ): Promise<ResolvedRegisteredResource | undefined> {
    return await this.summaries.resolve(resource)
      ?? await this.events.resolve(resource)
      ?? await this.workspaceIndexes.resolve(resource, query)
      ?? this.attachments.resolve(resource, runId);
  }
}
