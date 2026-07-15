// Fits D0/D1 branch indexes to the same deterministic token budget used by content expansion.

import type { BranchIndex, MemoryIndexEntry } from './types.js';
import { estimateTokens } from './util.js';

export function fitMemoryIndex(
  index: BranchIndex,
  budget: number,
  sanitize?: (content: string) => string,
): BranchIndex {
  if (budget <= 0) return { ...index, entries: [], truncated: index.entries.length > 0 };
  const entries: MemoryIndexEntry[] = [];
  let used = estimateTokens(`${index.displayName}\n${index.summary}`);
  for (const entry of index.entries) {
    const tokens = estimateTokens(`${entry.title}\n${entry.summary}\n${(entry.searchKeys ?? []).join(' ')}`);
    if (used + tokens > budget) {
      return {
        ...index,
        summary: safeText(index.summary, sanitize),
        entries,
        truncated: true,
        nextCursor: index.nextCursor ?? String(entries.length),
      };
    }
    entries.push({
      ...entry,
      title: safeText(entry.title, sanitize),
      summary: safeText(entry.summary, sanitize),
    });
    used += tokens;
  }
  return { ...index, summary: safeText(index.summary, sanitize), entries };
}

export function memoryIndexTokens(index: BranchIndex): number {
  return estimateTokens([
    index.displayName,
    index.summary,
    ...index.entries.map((entry) => `${entry.title} ${entry.summary}`),
  ].join('\n'));
}

function safeText(text: string, sanitize?: (content: string) => string): string {
  return sanitize ? sanitize(text) : text;
}
