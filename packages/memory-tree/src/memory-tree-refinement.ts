// Enforces bounded, deduplicated in-run memory refinement after the task book exists.

import type { MemoryBranchContext, MemoryPrimeOptions, MemoryPrimeResult } from './types.js';
import type { MemoryTaskQuery } from './task-query.js';
import type { ActiveMemoryRun } from './memory-tree-working-set.js';

const MAX_RUN_REFINEMENTS = 4;

export async function refineMemoryRun(
  run: ActiveMemoryRun,
  options: MemoryPrimeOptions,
  prime: () => Promise<MemoryPrimeResult>,
): Promise<MemoryPrimeResult> {
  const queryKey = normalizedRefinementQuery(options);
  if (!queryKey) return empty('empty-query');
  if (run.refinementQueryKeys.has(queryKey)) return empty('duplicate-query');
  if (run.refinementCount >= MAX_RUN_REFINEMENTS) return empty('refinement-limit');
  run.refinementQueryKeys.add(queryKey);
  run.refinementCount += 1;
  return prime();
}

export function memoryPrimeSelectionContext(
  context: MemoryBranchContext,
  query: string,
  taskQuery: MemoryTaskQuery,
): MemoryBranchContext {
  return taskQuery === context.taskQuery ? context : { ...context, query, taskQuery };
}

function normalizedRefinementQuery(options: MemoryPrimeOptions): string {
  const structured = options.taskQuery?.positiveSegments
    .map((segment) => `${segment.weight}:${segment.text}`)
    .join('\n');
  return (structured || options.query)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 8_000);
}

function empty(skippedReason: NonNullable<MemoryPrimeResult['skippedReason']>): MemoryPrimeResult {
  return { fragments: [], indexedBranches: [], tokensUsed: 0, skippedReason };
}
