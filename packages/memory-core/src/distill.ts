// @littlesheep/memory-core — distill.ts
// Distill daily memory into long-term MEMORY.md.
// MVP stub: appends raw daily content. Full LLM distillation in Phase 10.

import type { MemoryStoreLike } from '@littlesheep/types';

/** Append a daily file's content to MEMORY.md with a timestamp header. */
export async function distillDailyToMemory(
  store: MemoryStoreLike,
  date: string
): Promise<{ distilled: boolean; chars: number }> {
  const content = await store.readDaily(date);
  if (!content || content.trim().length === 0) {
    return { distilled: false, chars: 0 };
  }
  const header = `\n## Distilled from ${date}\n\n`;
  // MVP: raw append. Phase 10 will use LLM to summarize.
  await store.appendLongTerm(header + content);
  return { distilled: true, chars: content.length };
}

/** Mark a daily file as distilled (prefixes the file with a marker). */
export async function markDistilled(
  store: MemoryStoreLike,
  date: string
): Promise<void> {
  const content = await store.readDaily(date);
  if (!content || content.startsWith('<!-- distilled')) return;
  await store.writeDaily(date, `<!-- distilled ${new Date().toISOString()} -->\n${content}`);
}
