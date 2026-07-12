// @littlesheep/memory-tree — util.ts
// Pure utility functions for the memory injection protocol.
//
// All functions here are side-effect-free and testable in isolation. They are
// the building blocks for MemoryTree.applyBudget (estimateTokens,
// MIN_USEFUL_TOKENS, truncateChunk) and ProjectMemoryBranch.inject
// (activityScore).

import type { MemoryFragment } from './types.js';

/**
 * Rough token estimate: chars / 4. This is the standard approximation used by
 * most token-aware systems (actual tokenizers vary by model, but chars/4 is
 * within ~10% for English and slightly underestimates Chinese). We use it
 * because (1) it's zero-cost, (2) we only need approximate budget control, and
 * (3) loading a real tokenizer would add a heavy dependency for marginal gain.
 */
export function estimateTokens(text: string): number {
  // Math.ceil so a 1-char string still counts as 1 token (never 0).
  return Math.ceil(text.length / 4);
}

/**
 * Minimum token budget below which truncation is pointless (a chunk shorter
 * than this adds more framing overhead than content value). Used by
 * MemoryTree.applyBudget to decide whether to truncate a chunk that doesn't
 * fully fit, or drop it entirely.
 */
export const MIN_USEFUL_TOKENS = 64;

/**
 * Truncate a chunk's content to fit a token budget.
 *
 * Strategy: cut the content by character count (budget * 4), then append an
 * ellipsis marker so the LLM knows content was removed. Recompute tokenEstimate
 * from the truncated content.
 *
 * The chunk's other fields (branchId, tier, priority, metadata) are preserved.
 * `truncatable` stays true (it's already being truncated). The metadata gets a
 * `truncated: true` flag for source tracing.
 */
export function truncateChunk(chunk: MemoryFragment, budgetTokens: number): MemoryFragment {
  const maxChars = Math.max(0, budgetTokens * 4);
  if (chunk.content.length <= maxChars) return chunk;
  const truncated = chunk.content.slice(0, Math.max(0, maxChars - 3)) + '...';
  return {
    ...chunk,
    content: truncated,
    tokenEstimate: estimateTokens(truncated),
    metadata: { ...chunk.metadata, truncated: true },
  };
}

/** Milliseconds per day. Used by activityScore. */
const MS_PER_DAY = 86_400_000;

/**
 * Activity score for a project based on last-active time.
 *
 * Returns a priority weight in [0.1, 1.0]:
 *   - ≤1 day:   1.0  (active)
 *   - ≤7 days:  0.7  (recent)
 *   - ≤30 days: 0.4  (inactive)
 *   - >30 days: 0.1  (dormant — T2 skips these to save IO)
 *
 * Design source: memory-tree-injection-protocol.md §7.3 "活跃度评分".
 *
 * Dormant projects (score ≤ 0.1) are skipped in T2 collection because their
 * git log is unlikely to be relevant and the IO cost of spawning git is
 * wasted. They still appear in T1's project index (just marked "dormant").
 */
export function activityScore(lastActiveAt: Date, now: Date): number {
  const days = (now.getTime() - lastActiveAt.getTime()) / MS_PER_DAY;
  if (days <= 1) return 1.0;
  if (days <= 7) return 0.7;
  if (days <= 30) return 0.4;
  return 0.1;
}
