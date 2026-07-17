import {
  createAtomicActivationLevelCounts,
  projectAtomicActivationLevel,
  type AtomicActivationLevelCounts,
  type AtomicActivationUiLevel,
} from './activation.js';

export interface AtomicActivationProjectionEntry {
  id: string;
  score: number;
}

/** Keeps only the previous UI tier needed for hysteresis; scores remain authoritative elsewhere. */
export class AtomicActivationLevelTracker {
  private levels = new Map<string, AtomicActivationUiLevel>();

  constructor(private readonly maxEntries = 100_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Atomic activation projection maxEntries must be a positive integer.');
    }
  }

  project(entries: Iterable<AtomicActivationProjectionEntry>): AtomicActivationLevelCounts {
    const counts = createAtomicActivationLevelCounts();
    const next = new Map<string, AtomicActivationUiLevel>();
    for (const entry of entries) {
      if (next.size >= this.maxEntries) break;
      const id = entry.id.trim();
      if (!id || next.has(id)) continue;
      const level = projectAtomicActivationLevel(entry.score, this.levels.get(id));
      next.set(id, level);
      counts[level] += 1;
    }
    this.levels = next;
    return counts;
  }

  clear(): void {
    this.levels.clear();
  }

  get size(): number {
    return this.levels.size;
  }
}
