import { describe, expect, it } from 'vitest';
import { selectDeepSearchCluster } from './v3-retrieval-materializer.js';

describe('Memory v3 deep-search cluster selection', () => {
  it('stops at a clear relevance cliff instead of filling the requested limit', () => {
    const selected = selectDeepSearchCluster([
      candidate('constraint', 0.9),
      candidate('replacement', 0.878),
      candidate('adjacent', 0.741),
      candidate('noise', 0.72),
    ], 5);

    expect(selected.map((entry) => entry.id)).toEqual(['constraint', 'replacement']);
  });

  it('keeps a diffuse candidate set when no reliable split exists', () => {
    const selected = selectDeepSearchCluster([
      candidate('first', 0.79),
      candidate('second', 0.77),
      candidate('third', 0.74),
    ], 5);

    expect(selected.map((entry) => entry.id)).toEqual(['first', 'second', 'third']);
  });

  it('does not apply a sharp cutoff when even the top semantic match is weak', () => {
    const selected = selectDeepSearchCluster([
      candidate('first', 0.74),
      candidate('second', 0.6),
    ], 5);

    expect(selected.map((entry) => entry.id)).toEqual(['first', 'second']);
  });
});

function candidate(id: string, taskRelevance: number) {
  return { id, priority: { taskRelevance } };
}
