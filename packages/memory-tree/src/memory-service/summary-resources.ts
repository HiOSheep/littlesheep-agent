import type { CompactionSummary, SessionId } from '@littlesheep/types';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { MemoryServiceOptions } from './contracts.js';

export class SessionSummaryResourceCoordinator {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly resolveSummary: MemoryServiceOptions['resolveSessionSummary'],
  ) {}

  async register(sessionId: SessionId, summary: CompactionSummary): Promise<void> {
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
      indexKeys: ['summary memory', '会话摘要', summary.sourceStartMessageId, summary.sourceEndMessageId],
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
        ...(summary.version === 2 ? {
          cacheNamespace: summary.cache.namespace,
          cacheCompressionDepth: summary.cache.compressionDepth,
          cacheDisclosureLevel: summary.cache.disclosureLevel,
          cacheVectorClass: summary.cache.vectorClass,
          sourceSummaryIds: summary.sourceSummaryIds,
          mergedSummaryCount: summary.mergedSummaryCount,
          sourceHash: summary.sourceHash,
          lineageHash: summary.lineageHash,
        } : {}),
      },
    };
    await this.repository.replaceResourceGroup(resource.registryGroup, [resource], { staleMode: 'remove' });
  }

  async resolve(resource: MemoryResourceRegistration): Promise<{
    content: string;
    source: string;
    generatedAt: string;
  } | undefined> {
    if (resource.source.kind !== 'session-summary' || !resource.source.id || !resource.scopeKey) return undefined;
    const summary = await this.resolveSummary?.(resource.scopeKey as SessionId, resource.source.id);
    if (!summary || summary.id !== resource.id) return undefined;
    return {
      content: summary.summary,
      source: `session:${resource.scopeKey}#summary:${summary.id}`,
      generatedAt: summary.compactedAt,
    };
  }

  async observe(resource: MemoryResourceRegistration): Promise<'active' | 'missing'> {
    if (resource.source.kind !== 'session-summary' || !resource.source.id || !resource.scopeKey) return 'missing';
    const summary = await this.resolveSummary?.(resource.scopeKey as SessionId, resource.source.id);
    return summary?.id === resource.id ? 'active' : 'missing';
  }
}
