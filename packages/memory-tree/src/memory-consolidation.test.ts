import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@littlesheep/types';
import {
  InjectionTier,
  type MemoryManagementResult,
  type MemoryNode,
  type MemoryWriteIntent,
  type MemoryWriteResult,
} from './types.js';
import {
  MemoryDailyConsolidationService,
  type MemoryDailyConsolidationServiceOptions,
} from './memory-consolidation.js';

describe('MemoryDailyConsolidationService', () => {
  it('writes the target before archiving and preserves source epistemic metadata', async () => {
    const source = dailyNode();
    const order: string[] = [];
    const repository = repositoryFor([source], async (_id, _action, _reason, expectedRevision) => {
      order.push('archive');
      expect(expectedRevision).toBe(source.atomRevision);
      return archived(source);
    });
    const writer = {
      write: vi.fn(async (intent: MemoryWriteIntent): Promise<MemoryWriteResult> => {
        order.push('write');
        return { intentId: intent.id!, decision: 'created', reason: 'created', node: targetNode(intent) };
      }),
    };
    const invalidate = vi.fn();
    const service = new MemoryDailyConsolidationService({ repository, writer, invalidate });

    const result = await service.consolidate(input());

    expect(order).toEqual(['write', 'archive']);
    expect(result).toMatchObject({ status: 'completed', promoted: 1, archived: 1, retained: 0, failures: [] });
    const intent = writer.write.mock.calls[0]![0];
    expect(intent).toMatchObject({
      branch: 'project',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      tier: InjectionTier.T2_RELEVANT,
      sourceRunId: 'compaction-run',
      sourceRunIds: ['source-run'],
      sourceStage: 'maintenance',
      sourceStages: ['capture'],
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        assertedBy: { kind: 'tool', id: 'test-tool' },
      },
    });
    expect(intent.sourceRefs).toEqual(expect.arrayContaining([
      'conversation-source:source-run:user-message:message-1',
    ]));
    expect(intent.evidenceRefs).toEqual(expect.arrayContaining([
      `memory-v3:atom:${source.id}@${source.atomRevision}`,
      'session-summary:summary-1',
    ]));
    expect(invalidate).toHaveBeenCalledWith('daily');
  });

  it('retains the daily source when the target write is rejected', async () => {
    const source = dailyNode();
    const repository = repositoryFor([source]);
    const writer = {
      write: vi.fn(async (intent: MemoryWriteIntent): Promise<MemoryWriteResult> => ({
        intentId: intent.id!, decision: 'rejected', reason: 'policy rejected',
      })),
    };
    const result = await new MemoryDailyConsolidationService({ repository, writer }).consolidate(input());

    expect(result).toMatchObject({ promoted: 0, archived: 0, retained: 1 });
    expect(result.failures[0]?.error).toContain('rejected');
    expect(repository.manageNode).not.toHaveBeenCalled();
  });

  it('keeps the source after an archive revision conflict and completes on an idempotent retry', async () => {
    const source = dailyNode();
    let archiveAttempts = 0;
    const repository = repositoryFor([source], async () => {
      archiveAttempts += 1;
      if (archiveAttempts === 1) throw new Error('revision conflict');
      return archived(source);
    });
    let writeAttempts = 0;
    const writer = {
      write: vi.fn(async (intent: MemoryWriteIntent): Promise<MemoryWriteResult> => ({
        intentId: intent.id!,
        decision: writeAttempts++ === 0 ? 'created' : 'reinforced',
        reason: 'committed',
        node: targetNode(intent),
      })),
    };
    const service = new MemoryDailyConsolidationService({ repository, writer });

    const first = await service.consolidate(input());
    const second = await service.consolidate(input());

    expect(first).toMatchObject({ promoted: 1, archived: 0, retained: 1 });
    expect(first.failures[0]).toMatchObject({ atomId: source.id, stage: 'archive', error: 'revision conflict' });
    expect(second).toMatchObject({ promoted: 1, archived: 1, retained: 0, failures: [] });
    expect(writer.write.mock.calls[0]?.[0].id).toBe(writer.write.mock.calls[1]?.[0].id);
  });

  it('enforces candidate and batch bounds without scanning legacy summaries', async () => {
    const sources = Array.from({ length: 12 }, (_, index) => dailyNode({ id: `daily-${index}` }));
    const repository = repositoryFor(sources, async (id) => archived(sources.find((node) => node.id === id)!));
    const writer = {
      write: vi.fn(async (intent: MemoryWriteIntent): Promise<MemoryWriteResult> => ({
        intentId: intent.id!, decision: 'created', reason: 'created', node: targetNode(intent),
      })),
    };
    const service = new MemoryDailyConsolidationService({ repository, writer });
    const result = await service.consolidate(input({ candidateLimit: 50_000, batchLimit: 50_000 }));

    expect(repository.listRecentNodes).toHaveBeenCalledWith('daily', expect.objectContaining({ limit: 256 }));
    expect(writer.write).toHaveBeenCalledTimes(8);
    expect(result).toMatchObject({ eligible: 12, processed: 8, truncated: true });

    repository.listRecentNodes.mockClear();
    const legacy = await service.consolidate(input({ summary: {
      version: 1,
      id: 'legacy',
      collapsedCount: 1,
      summary: 'legacy',
      compactedAt: '2026-07-17T00:00:00.000Z',
      sourceStartMessageId: 'm1',
      sourceEndMessageId: 'm1',
      sourceStartAt: '2026-07-17T00:00:00.000Z',
      sourceEndAt: '2026-07-17T00:00:00.000Z',
    } }));
    expect(legacy).toMatchObject({ status: 'skipped', reason: 'legacy-summary', scanned: 0 });
    expect(repository.listRecentNodes).not.toHaveBeenCalled();
  });
});

function repositoryFor(
  nodes: MemoryNode[],
  manage: (...args: Parameters<MemoryDailyConsolidationServiceOptions['repository']['manageNode']>) => Promise<MemoryManagementResult | undefined>
    = async () => undefined,
) {
  return {
    backendKind: 'v3' as const,
    listRecentNodes: vi.fn(async () => nodes),
    manageNode: vi.fn(manage),
  };
}

function input(overrides: Partial<Parameters<MemoryDailyConsolidationService['consolidate']>[0]> = {}) {
  return {
    sessionId: asSessionId('session-1'),
    workspace: 'D:/repo',
    runId: 'compaction-run',
    summary: {
      version: 2 as const,
      id: 'summary-1',
      collapsedCount: 2,
      summary: 'summary',
      compactedAt: '2026-07-17T00:00:00.000Z',
      sourceStartMessageId: 'm1',
      sourceEndMessageId: 'm2',
      sourceStartAt: '2026-07-17T00:00:00.000Z',
      sourceEndAt: '2026-07-17T00:01:00.000Z',
      cache: {
        version: 1 as const,
        namespace: 'session-summary' as const,
        dataClass: 'semantic' as const,
        compressionDepth: 1 as const,
        disclosureLevel: 'D1' as const,
        vectorClass: 'semantic-cache' as const,
        sourceRefs: [],
        contentHash: 'summary-hash',
        createdAt: '2026-07-17T00:01:00.000Z',
      },
      sourceRanges: [],
      sourceSummaryIds: [],
      sourceRunIds: ['source-run'],
      sourceRunIdsTruncated: false,
      mergedSummaryCount: 1,
      sourceHash: 'source-hash',
      lineageHash: 'lineage-hash',
    },
    ...overrides,
  };
}

function dailyNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'daily-source',
    branch: 'daily',
    parentNodeId: 'daily:root',
    childIds: [],
    scope: 'workspace',
    scopeKey: 'D:/repo',
    tier: InjectionTier.T3_DETAIL,
    summary: 'Verified project fact',
    content: 'The project uses pnpm.',
    retrievalKeys: ['project', 'pnpm'],
    importance: 0.8,
    confidence: 0.9,
    reason: 'Verified during the run.',
    sourceRunIds: ['source-run'],
    sourceStages: ['capture'],
    sourceRefs: ['conversation-source:source-run:user-message:message-1'],
    evidenceRefs: ['run:source-run:tool:tool-1:succeeded'],
    domain: 'project',
    statementKind: 'factual-claim',
    epistemicStatus: 'verified',
    authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo', topics: ['package-manager'] },
    assertedBy: { kind: 'tool', id: 'test-tool' },
    entityRefs: ['entity:project'],
    relationRefs: ['relation:project-tool'],
    status: 'active',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    atomRevision: 3,
    ...overrides,
  };
}

function archived(source: MemoryNode): MemoryManagementResult {
  return {
    node: { ...source, status: 'archived' },
    audit: {
      id: 'audit-1',
      nodeId: source.id,
      branch: 'daily',
      action: 'archive',
      at: '2026-07-17T00:02:00.000Z',
      reason: 'promoted',
      fromStatus: 'active',
      toStatus: 'archived',
      fromTier: InjectionTier.T3_DETAIL,
      toTier: InjectionTier.T3_DETAIL,
    },
  };
}

function targetNode(intent: MemoryWriteIntent): MemoryNode {
  return {
    id: `target:${intent.id}`,
    branch: intent.branch,
    parentNodeId: intent.parentNodeId,
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
    status: 'active',
    createdAt: '2026-07-17T00:02:00.000Z',
    updatedAt: '2026-07-17T00:02:00.000Z',
  };
}
