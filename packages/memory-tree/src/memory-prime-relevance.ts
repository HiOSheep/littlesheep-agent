// Keeps D1 task admission separate from the governed priority used to order admitted atoms.

import type { MemoryIndexEntry } from './types.js';
import { scoreMemoryTaskRelevance } from './task-relevance.js';
import type { MemoryTaskQuery } from './task-query.js';

export interface MemoryPrimeIndexScore {
  taskRelevance: number;
  selectionScore: number;
}

export function scoreMemoryPrimeIndexEntry(
  query: string | MemoryTaskQuery,
  entry: MemoryIndexEntry,
): MemoryPrimeIndexScore {
  const explicit = Number(entry.relevance);
  const priority = entry.metadata?.priority;
  if (entry.metadata?.taskRelevanceResolved === true && Number.isFinite(explicit)) {
    const taskRelevance = clamp01(explicit);
    if (!priority || typeof priority !== 'object') return { taskRelevance, selectionScore: taskRelevance };
    const governedScore = Number((priority as { score?: unknown }).score);
    return {
      taskRelevance,
      selectionScore: Number.isFinite(governedScore) ? clamp01(governedScore) : taskRelevance,
    };
  }
  const lexicalResult = scoreMemoryTaskRelevance(query, {
    title: entry.title,
    summary: entry.summary,
    searchKeys: entry.searchKeys,
  });
  if (lexicalResult.blockedByExclusion) return { taskRelevance: 0, selectionScore: 0 };
  const lexical = lexicalResult.score;
  const taskRelevance = Math.max(
    Number.isFinite(explicit) ? clamp01(explicit) : 0,
    lexical,
  );
  if (!priority || typeof priority !== 'object') return { taskRelevance, selectionScore: taskRelevance };
  const governedScore = Number((priority as { score?: unknown }).score);
  return {
    taskRelevance,
    selectionScore: Number.isFinite(governedScore) ? clamp01(governedScore) : taskRelevance,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
