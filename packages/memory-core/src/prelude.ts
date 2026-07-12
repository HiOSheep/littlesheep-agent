// @littlesheep/memory-core — prelude.ts
// Every-turn recent memory injection: reads the last N days of daily memory
// and builds a markdown block to inject into the prompt.

import type { MemoryPrelude, MemoryStoreLike } from '@littlesheep/types';
import { formatDate } from './store.js';

export interface PreludeOptions {
  /** Number of days to include (default 3). */
  days?: number;
  /** Max chars per daily file (default 2000). */
  maxCharsPerDay?: number;
  /** Total max chars across all days (default 8000). */
  totalMaxChars?: number;
}

/** Build a recent-memory prelude block from the last N days of daily memory. */
export async function buildRecentPrelude(
  store: MemoryStoreLike,
  opts: PreludeOptions = {}
): Promise<MemoryPrelude> {
  const days = opts.days ?? 3;
  const maxPerDay = opts.maxCharsPerDay ?? 2000;
  const totalMax = opts.totalMaxChars ?? 8000;

  const blocks: string[] = [];
  let totalChars = 0;
  let daysIncluded = 0;
  let truncated = false;

  for (let i = days - 1; i >= 0; i--) {
    if (totalChars >= totalMax) {
      truncated = true;
      break;
    }
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = formatDate(d);
    const content = await store.readDaily(date);
    if (!content || content.trim().length === 0) continue;

    const remaining = totalMax - totalChars;
    const effectiveMax = Math.min(maxPerDay, remaining);
    let text = content;
    if (text.length > effectiveMax) {
      text = text.slice(0, effectiveMax) + '\n... [truncated]';
      truncated = true;
    }
    blocks.push(`### ${date}\n\n${text}`);
    totalChars += text.length;
    daysIncluded++;
  }

  const content = blocks.length > 0 ? blocks.join('\n\n') : '';
  return {
    generatedAt: new Date().toISOString(),
    daysIncluded,
    chars: totalChars,
    truncated,
    content,
  };
}
