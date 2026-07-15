// Owns run-scoped memory registration and cleanup without changing tree navigation semantics.

import type { MemoryAccessLedger, MemoryRunRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { MemoryTree } from '../memory-tree.js';
import type { MemoryRunResourceInput, MemoryRunStart } from './contracts.js';
import type { AttachmentResourceCoordinator } from './attachment-resources.js';
import type { RuntimeEventResourceCoordinator } from './runtime-event-resources.js';
import type { SessionSummaryResourceCoordinator } from './summary-resources.js';

export class MemoryRunCoordinator {
  constructor(
    private readonly tree: MemoryTree,
    private readonly repository: MemoryRepository,
    private readonly summaries: SessionSummaryResourceCoordinator,
    private readonly attachments: AttachmentResourceCoordinator,
    private readonly events: RuntimeEventResourceCoordinator,
    private readonly rootIndex: () => Promise<string>,
  ) {}

  async begin(input: MemoryRunRegistration): Promise<MemoryRunStart> {
    const rootIndex = input.rootIndex ?? await this.rootIndex();
    const t0Count = (await this.repository.listResources({ tier: 0, status: 'active' })).length;
    const ledger = this.tree.beginRun({
      ...input,
      rootIndex,
      rootSourceCount: input.rootSourceCount ?? this.tree.list().length + t0Count,
    });
    return { rootIndex, ledger };
  }

  async finish(runId: string): Promise<MemoryAccessLedger | undefined> {
    this.attachments.clearRun(runId);
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

  async registerResources(input: MemoryRunResourceInput): Promise<void> {
    if (input.summary) await this.summaries.register(input.sessionId, input.summary);
    await this.attachments.register(input.runId, input.sessionId, input.attachments ?? []);
    await this.events.register(input.runId, input.sessionId, input.runtimeEvents ?? []);
  }
}
