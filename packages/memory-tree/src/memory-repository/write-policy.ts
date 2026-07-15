// Normalizes and validates memory write intents before they can mutate the tree.

import { randomUUID } from 'node:crypto';
import { validateMemoryContent } from '@littlesheep/safety';
import { InjectionTier } from '../types.js';
import type { MemoryNode, MemoryWriteIntent, MemoryWritePolicy } from '../types.js';
import { clamp01, cleanText, normalizedText, textTerms, unique } from './text.js';

const DEFAULT_POLICY: MemoryWritePolicy = {
  experienceThreshold: 0.65,
  longTermConfidenceThreshold: 0.75,
  longTermImportanceThreshold: 0.7,
  projectConfidenceThreshold: 0.6,
  duplicateSimilarityThreshold: 0.82,
  maxAuditRecords: 2_000,
};

export function resolveMemoryWritePolicy(policy: Partial<MemoryWritePolicy> = {}): MemoryWritePolicy {
  return { ...DEFAULT_POLICY, ...policy };
}

export function normalizeMemoryIntent(intent: MemoryWriteIntent): MemoryWriteIntent {
  return {
    ...intent,
    id: intent.id ?? randomUUID(),
    parentNodeId: cleanText(intent.parentNodeId),
    scopeKey: intent.scopeKey ? cleanText(intent.scopeKey) : undefined,
    summary: cleanText(intent.summary),
    content: cleanText(intent.content),
    retrievalKeys: unique(intent.retrievalKeys.map((key) => cleanText(key).toLocaleLowerCase())).slice(0, 24),
    sourceRefs: unique((intent.sourceRefs ?? []).map((source) => cleanText(source))).slice(0, 24),
    reason: cleanText(intent.reason),
    importance: clamp01(intent.importance),
    confidence: clamp01(intent.confidence),
    createdAt: intent.createdAt ?? new Date().toISOString(),
  };
}

export function memoryNodeSimilarity(left: MemoryNode, right: MemoryWriteIntent): number {
  const a = textTerms(`${left.summary}\n${left.content}\n${left.retrievalKeys.join(' ')}`);
  const b = textTerms(`${right.summary}\n${right.content}\n${right.retrievalKeys.join(' ')}`);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function equivalentMemoryNode(node: MemoryNode, intent: MemoryWriteIntent): boolean {
  return normalizedText(node.summary) === normalizedText(intent.summary)
    && normalizedText(node.content) === normalizedText(intent.content);
}

export function memoryIntentRejectionReason(
  intent: MemoryWriteIntent,
  policy: MemoryWritePolicy,
): string | undefined {
  if (!intent.summary || !intent.content || !intent.reason || intent.retrievalKeys.length === 0) {
    return 'Missing summary, content, retrieval keys or write reason.';
  }
  if (intent.summary.length > 240 || intent.content.length > 4_000 || intent.reason.length > 500) {
    return 'Memory intent exceeds the indexed summary/content/reason size limit.';
  }
  const safety = validateMemoryContent(intent.content, { maxLength: 4_000 });
  if (!safety.ok) return `Memory content rejected by write-side safety: ${safety.reason ?? 'unsafe content'}.`;
  if (!intent.sourceRunId) return 'Missing source run id.';
  if (intent.tier === InjectionTier.T0_CORE) return 'Autonomous memory writes cannot target the fixed T0 registry tier.';
  if ((intent.scope === 'workspace' || intent.scope === 'project' || intent.scope === 'session') && !intent.scopeKey) {
    return `Scope "${intent.scope}" requires a scope key.`;
  }
  if (intent.branch === 'long-term') {
    if (intent.scope !== 'global') return 'Long-term memory must have global scope.';
    if (intent.confidence < policy.longTermConfidenceThreshold) return 'Long-term memory confidence is below the configured threshold.';
    if (intent.importance < policy.longTermImportanceThreshold) return 'Long-term memory importance is below the configured threshold.';
    if (isTemporaryOrEmotional(intent)) return 'Temporary, emotional or single-run state is not durable long-term memory.';
  }
  if (intent.branch === 'experience' && intent.confidence < policy.experienceThreshold) {
    return 'Experience confidence is below the balanced learning threshold.';
  }
  if (intent.branch === 'project') {
    if (intent.scope !== 'workspace' && intent.scope !== 'project') return 'Project memory requires workspace or project scope.';
    if (intent.confidence < policy.projectConfidenceThreshold) return 'Project memory confidence is below the configured threshold.';
  }
  if (intent.branch === 'daily' && intent.tier === InjectionTier.T1_ESSENTIAL) {
    return 'Daily process records cannot be promoted directly to T1 during capture.';
  }
  return undefined;
}

export function assertMemoryTierChange(branch: MemoryNode['branch'], tier: InjectionTier): void {
  if (![InjectionTier.T1_ESSENTIAL, InjectionTier.T2_RELEVANT, InjectionTier.T3_DETAIL].includes(tier)) {
    throw new Error('Managed memory nodes cannot enter the fixed T0 registry tier.');
  }
  if (branch === 'daily' && tier === InjectionTier.T1_ESSENTIAL) {
    throw new Error('Daily process records cannot be promoted to T1.');
  }
}

function isTemporaryOrEmotional(intent: MemoryWriteIntent): boolean {
  const text = `${intent.summary}\n${intent.content}`;
  return /(?:仅本轮|这一次运行|临时(?:文件|状态|想法)|刚才临时|当前情绪|我现在(?:很|有点)(?:开心|难过|生气|焦虑)|only this run|temporary run state|current mood)/iu.test(text);
}
