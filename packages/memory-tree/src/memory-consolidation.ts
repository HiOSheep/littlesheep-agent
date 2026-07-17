// Promotes bounded, compaction-covered daily atoms without deleting source evidence first.

import type { CompactionSummary, SessionId } from '@littlesheep/types';
import {
  InjectionTier,
  type MemoryBranchKind,
  type MemoryNode,
  type MemoryScope,
  type MemoryWriteIntent,
  type MemoryWriteResult,
} from './types.js';
import type { MemoryRepository, MemoryWriteService } from './memory-repository.js';

const DEFAULT_CANDIDATE_LIMIT = 256;
const DEFAULT_BATCH_LIMIT = 8;
const MAX_CANDIDATE_LIMIT = 256;
const MAX_BATCH_LIMIT = 8;
const SUCCESSFUL_WRITE_DECISIONS = new Set<MemoryWriteResult['decision']>([
  'created', 'merged', 'reinforced',
]);

export interface MemoryDailyConsolidationServiceOptions {
  repository: Pick<MemoryRepository, 'backendKind' | 'listRecentNodes' | 'manageNode'>;
  writer: Pick<MemoryWriteService, 'write'>;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export interface MemoryDailyConsolidationInput {
  sessionId: SessionId;
  workspace: string;
  runId: string;
  summary: CompactionSummary;
  candidateLimit?: number;
  batchLimit?: number;
}

export interface MemoryDailyConsolidationFailure {
  atomId: string;
  stage: 'write' | 'archive';
  error: string;
}

export interface MemoryDailyConsolidationResult {
  status: 'completed' | 'skipped';
  reason?: 'non-v3-backend' | 'legacy-summary' | 'missing-source-runs';
  scanned: number;
  eligible: number;
  processed: number;
  promoted: number;
  archived: number;
  retained: number;
  truncated: boolean;
  failures: MemoryDailyConsolidationFailure[];
}

interface ConsolidationTarget {
  branch: Exclude<MemoryBranchKind, 'daily'>;
  scope: MemoryScope;
  scopeKey?: string;
}

export class MemoryDailyConsolidationService {
  private readonly repository: MemoryDailyConsolidationServiceOptions['repository'];
  private readonly writer: MemoryDailyConsolidationServiceOptions['writer'];
  private readonly invalidate?: MemoryDailyConsolidationServiceOptions['invalidate'];

  constructor(options: MemoryDailyConsolidationServiceOptions) {
    this.repository = options.repository;
    this.writer = options.writer;
    this.invalidate = options.invalidate;
  }

  async consolidate(input: MemoryDailyConsolidationInput): Promise<MemoryDailyConsolidationResult> {
    if (this.repository.backendKind !== 'v3') return skipped('non-v3-backend');
    if (input.summary.version !== 2) return skipped('legacy-summary');
    const sourceRunIds = new Set((input.summary.sourceRunIds ?? []).filter(Boolean));
    if (sourceRunIds.size === 0) return skipped('missing-source-runs');

    const candidateLimit = boundedLimit(input.candidateLimit, DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT);
    const batchLimit = boundedLimit(input.batchLimit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
    const candidates = await this.repository.listRecentNodes('daily', {
      scope: 'workspace',
      scopeKey: input.workspace,
      status: 'active',
      limit: candidateLimit,
    });
    const eligible = candidates
      .filter((node) => eligibleDailyNode(node, sourceRunIds))
      .map((node) => ({ node, target: consolidationTarget(node) }))
      .filter((entry): entry is { node: MemoryNode; target: ConsolidationTarget } => Boolean(entry.target));
    const selected = eligible.slice(0, batchLimit);
    const failures: MemoryDailyConsolidationFailure[] = [];
    let promoted = 0;
    let archived = 0;

    for (const { node, target } of selected) {
      const intent = consolidationIntent(input, node, target);
      let writeResult: MemoryWriteResult;
      try {
        writeResult = await this.writer.write(intent);
      } catch (error) {
        failures.push({ atomId: node.id, stage: 'write', error: errorMessage(error) });
        continue;
      }
      if (!SUCCESSFUL_WRITE_DECISIONS.has(writeResult.decision)) {
        failures.push({
          atomId: node.id,
          stage: 'write',
          error: `${writeResult.decision}: ${writeResult.reason}`,
        });
        continue;
      }
      promoted += 1;
      try {
        const archivedResult = await this.repository.manageNode(
          node.id,
          'archive',
          `Daily atom promoted after session compaction ${input.summary.id}.`,
          node.atomRevision,
        );
        if (!archivedResult || archivedResult.node.status !== 'archived') {
          throw new Error('The daily atom was not archived after its target write committed.');
        }
        archived += 1;
      } catch (error) {
        failures.push({ atomId: node.id, stage: 'archive', error: errorMessage(error) });
      }
    }

    if (archived > 0) await this.invalidate?.('daily');
    return {
      status: 'completed',
      scanned: candidates.length,
      eligible: eligible.length,
      processed: selected.length,
      promoted,
      archived,
      retained: selected.length - archived,
      truncated: candidates.length >= candidateLimit || eligible.length > selected.length,
      failures,
    };
  }
}

function eligibleDailyNode(node: MemoryNode, sourceRunIds: ReadonlySet<string>): boolean {
  if (node.branch !== 'daily' || node.status !== 'active' || node.isBranchRoot) return false;
  if (node.childIds.length > 0 || node.atomRevision === undefined) return false;
  if (!node.sourceStages.includes('capture')) return false;
  if (!node.sourceRunIds.some((runId) => sourceRunIds.has(runId))) return false;
  if (!node.domain || !node.statementKind || !node.epistemicStatus || !node.authorityScope || !node.assertedBy) return false;
  if (node.epistemicStatus === 'disputed' || node.epistemicStatus === 'superseded') return false;
  if (node.statementKind === 'suggestion' || node.statementKind === 'hypothesis' || node.statementKind === 'approval') return false;
  if (node.assertedBy.kind === 'user') {
    return ['instruction', 'goal', 'preference', 'value', 'decision'].includes(node.statementKind);
  }
  return node.epistemicStatus === 'corroborated' || node.epistemicStatus === 'verified';
}

function consolidationTarget(node: MemoryNode): ConsolidationTarget | undefined {
  if (node.domain === 'experience') {
    return { branch: 'experience', scope: node.scope, scopeKey: node.scopeKey };
  }
  if (node.scope === 'workspace' || node.scope === 'project') {
    if (node.domain === 'project' || node.domain === 'knowledge' || node.domain === 'user') {
      return { branch: 'project', scope: node.scope, scopeKey: node.scopeKey };
    }
    return undefined;
  }
  if (node.scope === 'global'
    && (node.domain === 'user' || node.domain === 'agent-self' || node.domain === 'knowledge')) {
    return { branch: 'long-term', scope: 'global' };
  }
  return undefined;
}

function consolidationIntent(
  input: MemoryDailyConsolidationInput,
  source: MemoryNode,
  target: ConsolidationTarget,
): MemoryWriteIntent {
  const atomRef = `memory-v3:atom:${source.id}@${source.atomRevision}`;
  return {
    id: `maintenance:daily-consolidation:${source.id}:${source.atomRevision}`,
    branch: target.branch,
    parentNodeId: `${target.branch}:root`,
    scope: target.scope,
    scopeKey: target.scopeKey,
    tier: InjectionTier.T2_RELEVANT,
    summary: source.summary,
    content: source.content,
    retrievalKeys: [...source.retrievalKeys],
    sourceRunId: input.runId,
    sourceRunIds: [...source.sourceRunIds],
    sourceStage: 'maintenance',
    sourceStages: [...source.sourceStages],
    sourceRefs: [...(source.sourceRefs ?? [])],
    evidenceRefs: [...(source.evidenceRefs ?? []), atomRef, `session-summary:${input.summary.id}`],
    importance: source.importance,
    confidence: source.confidence,
    reason: `Promoted from daily atom ${source.id}@${source.atomRevision} after bounded session compaction. ${source.reason}`,
    createdAt: input.summary.compactedAt,
    epistemic: {
      domain: source.domain!,
      statementKind: source.statementKind!,
      epistemicStatus: source.epistemicStatus!,
      authorityScope: structuredClone(source.authorityScope!),
      assertedBy: structuredClone(source.assertedBy!),
      evidenceRefs: [...(source.evidenceRefs ?? [])],
      entityRefs: [...(source.entityRefs ?? [])],
      relationRefs: [...(source.relationRefs ?? [])],
    },
  };
}

function skipped(reason: MemoryDailyConsolidationResult['reason']): MemoryDailyConsolidationResult {
  return {
    status: 'skipped',
    reason,
    scanned: 0,
    eligible: 0,
    processed: 0,
    promoted: 0,
    archived: 0,
    retained: 0,
    truncated: false,
    failures: [],
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value! <= 0) return fallback;
  return Math.min(value!, maximum);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
