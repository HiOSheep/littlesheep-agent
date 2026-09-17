// Per-write embedding reuse accounting for Memory v3.
//
// Re-writing an unchanged atom keeps its existing vector (`catalog.ts` compares
// `embedding_hash` and preserves a ready/stale status instead of re-embedding).
// That is a real local cache event: the Runtime can report how many embeddings
// were reused versus newly queued instead of guessing.
export type EmbeddingReuseOutcome = 'reused' | 'queued' | 'disabled';

export interface EmbeddingReuseCounts {
  reused: number;
  queued: number;
  disabled: number;
}

export function emptyEmbeddingReuseCounts(): EmbeddingReuseCounts {
  return { reused: 0, queued: 0, disabled: 0 };
}

export function addEmbeddingReuseCounts(
  left: EmbeddingReuseCounts,
  right: EmbeddingReuseCounts | undefined,
): EmbeddingReuseCounts {
  if (!right) return left;
  return {
    reused: left.reused + right.reused,
    queued: left.queued + right.queued,
    disabled: left.disabled + right.disabled,
  };
}

export function embeddingReuseObserved(counts: EmbeddingReuseCounts): boolean {
  return counts.reused + counts.queued > 0;
}

/** Classify one catalog upsert by whether it needed new embedding work. */
export function embeddingReuseOutcome(input: {
  eligible: boolean;
  changed: boolean;
  previousStatus: string | undefined;
}): EmbeddingReuseOutcome {
  if (!input.eligible) return 'disabled';
  if (input.changed) return 'queued';
  return input.previousStatus === 'ready' || input.previousStatus === 'stale' ? 'reused' : 'queued';
}

export class EmbeddingReuseTally {
  private counts: EmbeddingReuseCounts = emptyEmbeddingReuseCounts();

  record(outcome: EmbeddingReuseOutcome): void {
    this.counts[outcome] += 1;
  }

  drain(): EmbeddingReuseCounts {
    const drained = this.counts;
    this.counts = emptyEmbeddingReuseCounts();
    return drained;
  }
}
