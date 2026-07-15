// Keeps the v2 compatibility branch projection isolated from Memory v3 retrieval.

import type { MemoryFragment, MemoryIndexEntry, MemoryNode } from './types.js';
import { estimateTokens } from './util.js';

export function legacyNodeRelevance(node: MemoryNode, query: string): number {
  if (!query.trim()) return node.importance * 0.55 + node.confidence * 0.35 + 0.1;
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = `${node.summary}\n${node.content}\n${node.retrievalKeys.join(' ')}`.toLocaleLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return Math.min(1, matches / terms.length * 0.7 + node.importance * 0.18 + node.confidence * 0.12);
}

export function legacyNodeIndexEntry(node: MemoryNode): MemoryIndexEntry {
  return {
    id: node.id,
    title: node.summary,
    summary: `${node.scope}${node.scopeKey ? `:${node.scopeKey}` : ''}; tier T${node.tier}; confidence ${node.confidence.toFixed(2)}`,
    hasChildren: node.childIds.length > 0,
    searchKeys: node.retrievalKeys.slice(0, 8),
    updatedAt: node.updatedAt,
    metadata: {
      tier: node.tier,
      scope: node.scope,
      scopeKey: node.scopeKey,
      importance: node.importance,
      confidence: node.confidence,
      reason: node.reason,
    },
  };
}

export function legacyNodeFragment(
  node: MemoryNode,
  branchId: string,
  reason: string,
  score: number,
  source: string,
): MemoryFragment {
  const content = [
    `## ${node.summary}`,
    node.content,
    '',
    `Source reason: ${node.reason}`,
  ].join('\n');
  return {
    id: node.id,
    branchId,
    parentNodeId: node.parentNodeId,
    tier: node.tier,
    priority: Math.max(0, Math.min(1, score)),
    content,
    tokenEstimate: estimateTokens(content),
    truncatable: true,
    dedupKey: `tree-node:${node.id}:${node.updatedAt}`,
    matchReason: reason,
    metadata: {
      source,
      kind: 'indexed-memory-node',
      generatedAt: node.updatedAt,
      runId: node.sourceRunIds.at(-1),
      sourceRunIds: node.sourceRunIds,
      sourceStages: node.sourceStages,
      scope: node.scope,
      scopeKey: node.scopeKey,
      confidence: node.confidence,
      importance: node.importance,
      writeReason: node.reason,
    },
  };
}

function queryTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  const cjk = [...normalized].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  for (let index = 0; index + 1 < cjk.length; index += 1) words.push(cjk[index]! + cjk[index + 1]!);
  return [...new Set(words)];
}
