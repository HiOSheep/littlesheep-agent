// @littlesheep/tools — builtin/memory_deep_search.ts
// Read-only compatibility search for existing Memory v2 archive files:
// daily files (archive/YYYY/MM/DD.md), monthly summaries
// (archive/YYYY/MM/summary.md), and yearly summaries (archive/YYYY/summary.md).
//
// STRICTLY READ-ONLY. This tool NEVER calls vectorStore.insert() — it searches
// the raw archive files directly via ripgrep (with a naive fallback). This
// Existing files remain queryable after the v2 writer is retired. This adapter
// must never create archives, summaries, vectors, or Memory v3 Atoms.

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { relative, sep } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import type { MemoryTier } from '@littlesheep/types';
import { withToolTiming } from '../wrapper.js';

const MemoryDeepSearchInput = z.object({
  query: z.string().describe('Search text (keyword or regex).'),
  limit: z.number().int().positive().optional().default(50),
  since: z.string().optional().describe('Date lower bound (YYYY-MM-DD / YYYY-MM / YYYY). Inclusive.'),
  until: z.string().optional().describe('Date upper bound (YYYY-MM-DD / YYYY-MM / YYYY). Inclusive.'),
});

interface ArchiveHit {
  date: string;
  tier: MemoryTier;
  snippet: string;
}

/**
 * Parse a date + tier from an archive file's relative path.
 *
 *   2025/03/15.md       → { date: '2025-03-15', tier: 'daily' }
 *   2025/03/summary.md  → { date: '2025-03',    tier: 'monthly-summary' }
 *   2025/summary.md     → { date: '2025',       tier: 'yearly-summary' }
 *
 * Returns null for unrecognised paths.
 */
function parseArchivePath(relPath: string): { date: string; tier: MemoryTier } | null {
  const parts = relPath.split(sep).filter((p) => p.length > 0);

  if (parts.length === 3) {
    // YYYY/MM/DD.md  OR  YYYY/MM/summary.md
    const [yyyy, mm, fname] = parts;
    if (!/^\d{4}$/.test(yyyy!) || !/^\d{2}$/.test(mm!)) return null;
    if (/^\d{2}\.md$/.test(fname!)) {
      return { date: `${yyyy}-${mm}-${fname!.replace(/\.md$/, '')}`, tier: 'daily' };
    }
    if (fname === 'summary.md') {
      return { date: `${yyyy}-${mm}`, tier: 'monthly-summary' };
    }
    return null;
  }

  if (parts.length === 2) {
    // YYYY/summary.md
    const [yyyy, fname] = parts;
    if (/^\d{4}$/.test(yyyy!) && fname === 'summary.md') {
      return { date: yyyy!, tier: 'yearly-summary' };
    }
    return null;
  }

  return null;
}

/**
 * Search the archive dir with ripgrep. Returns null if rg is unavailable
 * (so the caller can fall back to naive search).
 */
function searchWithRipgrep(
  archiveDir: string,
  query: string,
  limit: number,
): Promise<ArchiveHit[] | null> {
  return new Promise((resolve) => {
    const args = ['--json', '--max-count', String(limit), query, archiveDir];
    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let settled = false;
    const finish = (value: ArchiveHit[] | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    proc.stdout?.on('data', (d) => (stdout += d.toString()));

    proc.on('error', () => finish(null));
    // `close` fires after stdio streams close; `exit` can precede the final stdout chunk on Windows.
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        finish(null);
        return;
      }
      const hits: ArchiveHit[] = [];
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        if (hits.length >= limit) break;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match' && obj.data) {
            const filePath: string = obj.data.path?.text ?? '';
            const relPath = relative(archiveDir, filePath);
            const parsed = parseArchivePath(relPath);
            if (!parsed) continue;
            const snippet: string = (obj.data.lines?.text ?? '').trim();
            hits.push({ date: parsed.date, tier: parsed.tier, snippet });
          }
        } catch {
          // skip non-JSON lines
        }
      }
      finish(hits);
    });
  });
}

/** Fallback: recursively read archive .md files and do a substring search. */
async function naiveArchiveSearch(
  archiveDir: string,
  query: string,
  limit: number,
): Promise<ArchiveHit[]> {
  const hits: ArchiveHit[] = [];
  const needle = query.toLowerCase();

  async function walkDir(dir: string): Promise<void> {
    if (hits.length >= limit) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= limit) return;
      const p = `${dir}${sep}${name}`;
      let s;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walkDir(p);
      } else if (s.isFile() && name.endsWith('.md')) {
        const relPath = relative(archiveDir, p);
        const parsed = parseArchivePath(relPath);
        if (!parsed) continue;
        const content = await readFile(p, 'utf8');
        for (const line of content.split('\n')) {
          if (hits.length >= limit) break;
          if (line.toLowerCase().includes(needle)) {
            hits.push({ date: parsed.date, tier: parsed.tier, snippet: line.trim() });
          }
        }
      }
    }
  }

  await walkDir(archiveDir);
  return hits;
}

export function createMemoryDeepSearchTool(archiveDir: string): AgentTool {
  return {
    name: 'memory_deep_search',
    description:
      'Read existing legacy archive files by keyword. ' +
      'Compatibility-only and read-only; never creates summaries, vectors, or Memory v3 Atoms.',
    inputSchema: MemoryDeepSearchInput,
    execute: withToolTiming(async (input) => {
      const { query, limit, since, until } = MemoryDeepSearchInput.parse(input);

      if (!existsSync(archiveDir)) {
        return {
          output: 'No archive directory exists yet.',
          meta: { hits: 0 },
        };
      }

      // Try ripgrep first; fall back to naive search if unavailable.
      let hits = await searchWithRipgrep(archiveDir, query, limit);
      if (hits === null) {
        hits = await naiveArchiveSearch(archiveDir, query, limit);
      }

      // Filter by date range (lexicographic compare on YYYY-MM-DD / YYYY-MM / YYYY).
      const filtered = hits.filter((h) => {
        if (since && h.date < since) return false;
        if (until && h.date > until) return false;
        return true;
      });

      const lines = filtered.map((h) => `[${h.tier}] ${h.date} — ${h.snippet}`);
      const output = lines.length > 0
        ? lines.join('\n')
        : 'No archived memory matches found';

      return {
        output,
        meta: { hits: filtered.length },
      };
    }),
  };
}
