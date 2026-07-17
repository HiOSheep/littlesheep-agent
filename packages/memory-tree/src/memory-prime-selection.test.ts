import { describe, expect, it } from 'vitest';
import { selectMemoryPrimeCandidates, type MemoryPrimeCandidate } from './memory-prime-selection.js';

describe('Memory prime relation admission', () => {
  it('admits an independently relevant strong relation candidate across the ordinary relevance cliff', () => {
    const selected = selectMemoryPrimeCandidates([
      candidate('seed', 1, 0.9),
      candidate('required-dependency', 0.34, 0.72, 'relation', 0.82),
      candidate('ordinary-tail', 0.34, 0.71),
    ], 3);

    expect(selected.map((item) => item.nodeId)).toEqual(['seed', 'required-dependency']);
  });

  it('does not let a relation bypass the independent task or route-strength gates', () => {
    const selected = selectMemoryPrimeCandidates([
      candidate('seed', 1, 0.9),
      candidate('below-task-gate', 0.25, 0.8, 'relation', 0.95),
      candidate('weak-route', 0.4, 0.75, 'relation', 0.6),
    ], 3);

    expect(selected.map((item) => item.nodeId)).toEqual(['seed']);
  });
});

function candidate(
  nodeId: string,
  taskRelevance: number,
  selectionScore: number,
  retrievalPath?: MemoryPrimeCandidate['retrievalPath'],
  relationStrength?: number,
): MemoryPrimeCandidate {
  return {
    branchId: 'project',
    nodeId,
    taskRelevance,
    selectionScore,
    order: 0,
    retrievalPath,
    relationStrength,
  };
}
