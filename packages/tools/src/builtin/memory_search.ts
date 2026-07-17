// @littlesheep/tools — builtin/memory_search.ts
// Legacy library adapter for long-term/daily files, an optional v2 vector
// index, and the experience DB. The LS runtime does not register this tool;
// production memory navigation is owned by @littlesheep/memory-tree.
//
// Search order (results merged, not ranked across sources):
//   1. Vector search (semantic) — if a vectorStore is provided. Catches errors
//      so an embedding API failure never blocks the file/experience fallbacks.
//   2. File search (ripgrep keyword) — always runs; may overlap with vector
//      hits for recent daily entries (acceptable — the user gets more context).
//   3. Experience DB (structured insights, sorted by confidence).

import { z } from 'zod';
import type { AgentTool, MemoryStoreLike } from '@littlesheep/types';
import type { ExperienceStore } from '@littlesheep/experience';
import type { VectorStore } from '@littlesheep/vector';
import { searchMemory } from '@littlesheep/memory-core';
import { withToolTiming } from '../wrapper.js';

const MemorySearchInput = z.object({
  query: z.string().describe('Search text.'),
  limit: z.number().int().positive().optional().default(20),
});

/** @deprecated Use the Memory v3 compatibility tool from @littlesheep/memory-tree. */
export function createMemorySearchTool(
  store: MemoryStoreLike,
  experienceStore?: ExperienceStore,
  vectorStore?: VectorStore,
): AgentTool {
  return {
    name: 'memory_search',
    description: 'Legacy read-only memory search adapter. The Memory v3 runtime uses index-first navigation instead.',
    inputSchema: MemorySearchInput,
    execute: withToolTiming(async (input) => {
      const { query, limit } = MemorySearchInput.parse(input);
      const lines: string[] = [];
      let vectorHits = 0;

      // 1. Vector search (semantic) — best-effort, never blocks fallbacks.
      if (vectorStore) {
        try {
          const vHits = await vectorStore.search(query, limit);
          vectorHits = vHits.length;
          for (const h of vHits) {
            const snippet = h.text.length > 200 ? h.text.slice(0, 200) + '…' : h.text;
            lines.push(`[vector:${h.tier}] ${h.date} — ${snippet}`);
          }
        } catch {
          // Embedding API error, DB corruption, etc. — fall through to file search.
        }
      }

      // 2. File search (ripgrep keyword on memory/ + MEMORY.md).
      const hits = await searchMemory(store, { query, limit });
      for (const h of hits) {
        lines.push(`${h.file}:${h.line ?? '?'} — ${h.snippet}`);
      }

      // 3. Experience DB (structured insights, sorted by confidence).
      let expCount = 0;
      if (experienceStore) {
        const expHits = await experienceStore.search(query, limit);
        expCount = expHits.length;
        for (const e of expHits) {
          const snippet = e.content.length > 200 ? e.content.slice(0, 200) + '…' : e.content;
          lines.push(`experience:${e.id} — [${e.category}] ${snippet}`);
        }
      }

      const output = lines.length > 0
        ? lines.join('\n')
        : 'No memory matches found';
      return {
        output,
        meta: { hits: hits.length, vectorHits, experienceHits: expCount },
      };
    }),
  };
}
