// Projects Memory v3 retrieval candidates into D1 indexes and D2/D3 prompt fragments.

import type {
  MemoryBranchContext,
  MemoryFragment,
  MemoryIndexEntry,
} from './types.js';
import { estimateTokens } from './util.js';
import type { MemoryRepositoryCandidate, MemoryRetrievalScope } from './memory-repository/retrieval.js';

export function retrievalScopes(ctx: MemoryBranchContext): MemoryRetrievalScope[] {
  return [
    { scope: 'global' },
    { scope: 'workspace', scopeKey: ctx.workspace },
    { scope: 'project', scopeKey: ctx.workspace },
    { scope: 'session', scopeKey: String(ctx.sessionId) },
  ];
}

export function toV3IndexEntry(candidate: MemoryRepositoryCandidate): MemoryIndexEntry {
  const atom = candidate.atom;
  const authority = `${atom.authorityScope.kind}:${atom.authorityScope.scope}${atom.authorityScope.scopeKey ? `:${atom.authorityScope.scopeKey}` : ''}`;
  const warnings = [
    candidate.envelope.conflict ? 'conflict' : undefined,
    candidate.envelope.expired ? 'expired' : undefined,
    ['reported', 'unverified', 'disputed'].includes(atom.epistemicStatus) ? atom.epistemicStatus : undefined,
  ].filter(Boolean).join(',');
  return {
    id: atom.id,
    title: atom.title || atom.summary,
    relevance: candidate.priority.taskRelevance,
    summary: [
      atom.summary,
      `${atom.domain}/${atom.statementKind}/${atom.epistemicStatus}`,
      `scope=${atom.scope}${atom.scopeKey ? `:${atom.scopeKey}` : ''}`,
      `authority=${authority}`,
      `confidence=${atom.confidence.toFixed(2)}`,
      `task=${candidate.priority.taskRelevance.toFixed(3)}`,
      `priority=${candidate.priority.score.toFixed(3)}`,
      warnings ? `warning=${warnings}` : undefined,
    ].filter(Boolean).join('; '),
    hasChildren: candidate.hasChildren,
    searchKeys: atom.retrievalKeys.slice(0, 8),
    updatedAt: atom.updatedAt,
    evidence: candidate.envelope,
    metadata: {
      tier: atom.tier,
      domain: atom.domain,
      statementKind: atom.statementKind,
      epistemicStatus: atom.epistemicStatus,
      authorityScope: atom.authorityScope,
      priority: candidate.priority,
      taskRelevanceResolved: true,
    },
  };
}

export function toV3Fragment(candidate: MemoryRepositoryCandidate, branchId: string): MemoryFragment {
  const atom = candidate.atom;
  const evidence = candidate.envelope;
  const lines = [
    `## ${atom.title || atom.summary}`,
    atom.content,
    '',
    'Evidence metadata:',
    `- atom: ${atom.id}@${atom.revision}; parent=${evidence.parentNodeId ?? '(branch root)'}; disclosure=${evidence.disclosureLevel}; path=${evidence.retrievalPath}`,
    `- statement: ${atom.statementKind}; epistemic=${atom.epistemicStatus}; resolution=${atom.resolutionStatus}`,
    `- authority: ${atom.authorityScope.kind}/${atom.authorityScope.scope}${atom.authorityScope.scopeKey ? `:${atom.authorityScope.scopeKey}` : ''}; assertedBy=${atom.assertedBy.kind}${atom.assertedBy.id ? `:${atom.assertedBy.id}` : ''}`,
    `- confidence=${atom.confidence.toFixed(2)}; importance=${atom.importance.toFixed(2)}; task=${evidence.taskRelevance.toFixed(2)}; routing=${evidence.routingRelevance.toFixed(2)}; relation=${evidence.relationshipRelevance.toFixed(2)}; activation=${evidence.activation.score.toFixed(2)}; updated=${atom.updatedAt}${atom.lastVerifiedAt ? `; verified=${atom.lastVerifiedAt}` : ''}`,
    `- evidence refs: ${atom.evidenceRefs.length > 0 ? atom.evidenceRefs.slice(0, 12).join(', ') : '(none)'}`,
    `- use boundary: ${evidence.conflict ? 'CONFLICTED - do not treat as settled fact' : epistemicUseBoundary(atom.statementKind, atom.epistemicStatus)}`,
  ];
  if (evidence.relationRoute) {
    lines.push(
      `- relation route: seed=${evidence.relationRoute.seedAtomId}; ${evidence.relationRoute.relationType}/${evidence.relationRoute.direction}; relation=${evidence.relationRoute.relationId}; confidence=${evidence.relationRoute.confidence.toFixed(2)}; relevance=${evidence.relationRoute.relevance.toFixed(2)}; strength=${evidence.relationRoute.strength.toFixed(2)}`,
    );
  }
  if (candidate.neighborhood) {
    lines.push('', 'Relevant relation neighborhood:');
    for (const relation of candidate.neighborhood.relations) {
      lines.push(`- ${relation.fromEntityId} --${relation.type}--> ${relation.toEntityId}; status=${relation.status}; confidence=${relation.confidence.toFixed(2)}; relevance=${relation.relevance.toFixed(2)}`);
    }
    if (candidate.neighborhood.truncated) lines.push('- ... relation neighborhood bounded');
  }
  if (candidate.history) {
    lines.push('', 'D3 source and audit history:');
    lines.push(`- source runs: ${candidate.history.sourceRunIds.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- source stages: ${candidate.history.sourceStages.join(', ') || '(none)'}`);
    for (const entry of candidate.history.entries) lines.push(`- ${entry.at} [${entry.kind}] ${entry.summary}`);
    if (candidate.history.truncated) lines.push('- ... audit history bounded');
  }
  const content = lines.join('\n');
  return {
    id: atom.id,
    branchId,
    parentNodeId: atom.parentId,
    tier: atom.tier,
    priority: candidate.priority.score,
    content,
    tokenEstimate: estimateTokens(content),
    truncatable: true,
    dedupKey: `memory-v3:${atom.id}:${atom.revision}:${evidence.disclosureLevel}`,
    matchReason: evidence.matchReason,
    evidence,
    metadata: {
      source: `memory-v3:atom:${atom.id}`,
      kind: 'memory-v3-atom',
      generatedAt: atom.updatedAt,
      runId: atom.sourceRunIds.at(-1),
      scope: atom.scope,
      scopeKey: atom.scopeKey,
      domain: atom.domain,
      statementKind: atom.statementKind,
      epistemicStatus: atom.epistemicStatus,
      confidence: atom.confidence,
      importance: atom.importance,
    },
  };
}

function epistemicUseBoundary(
  statement: MemoryRepositoryCandidate['atom']['statementKind'],
  status: MemoryRepositoryCandidate['atom']['epistemicStatus'],
): string {
  if (statement === 'suggestion' || statement === 'hypothesis') return 'advice/hypothesis only; adoption does not verify truth';
  if (statement === 'reported-observation' || status === 'reported') return 'reported claim only; verify before presenting as fact';
  if (status === 'unverified') return 'unverified claim; corroborate before presenting as fact';
  return status === 'verified' || status === 'corroborated'
    ? 'may support a factual conclusion within its authority and scope'
    : 'contextual evidence only';
}
