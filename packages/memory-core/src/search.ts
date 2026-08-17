// @littlesheep/memory-core — search.ts
// MVP memory search: wraps ripgrep (rg) to search memory/*.md + MEMORY.md.
// No FTS5 / sqlite-vec in MVP — pure file grep.

import { spawn } from 'node:child_process';
import type { MemoryHit, SearchQuery, MemoryTier, MemoryStoreLike } from '@littlesheep/types';

/** Check if ripgrep (rg) is available on PATH. */
export function isRipgrepAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('rg', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

/** Fallback: read all memory files and do a naive substring search. */
async function naiveSearch(
  store: MemoryStoreLike,
  query: SearchQuery
): Promise<MemoryHit[]> {
  const hits: MemoryHit[] = [];
  const limit = query.limit ?? 20;
  const needle = query.query.toLowerCase();

  // Search long-term MEMORY.md
  const longTerm = await store.readLongTerm();
  if (longTerm) {
    const lines = longTerm.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        hits.push({
          file: store.longTermPath,
          line: i + 1,
          snippet: lines[i]!,
          tier: 'long-term',
        });
      }
    }
  }

  // Search daily files
  const dates = await store.listDailyDates();
  for (const date of dates) {
    if (hits.length >= limit) break;
    const content = await store.readDaily(date);
    if (!content) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        hits.push({
          file: store.dailyFile(date),
          line: i + 1,
          snippet: lines[i]!,
          tier: 'daily',
        });
      }
    }
  }

  return hits;
}

/** Search memory files using ripgrep (falls back to naive if rg missing). */
export async function searchMemory(
  store: MemoryStoreLike,
  query: SearchQuery
): Promise<MemoryHit[]> {
  const limit = query.limit ?? 20;

  // Try ripgrep first.
  const rgAvailable = await isRipgrepAvailable();
  if (!rgAvailable) {
    return naiveSearch(store, query);
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--json',
      '--max-count', String(limit),
      query.query,
      store.dailyDirPath,
      store.longTermPath,
    ];
    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));

    proc.on('error', () => {
      // If rg fails at runtime, fall back.
      naiveSearch(store, query).then(resolve).catch(reject);
    });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== 1) {
        // rg exits 1 for "no matches", which is fine. Other codes = error.
        naiveSearch(store, query).then(resolve).catch(reject);
        return;
      }
      const hits: MemoryHit[] = [];
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        if (hits.length >= limit) break;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match' && obj.data) {
            const filePath = obj.data.path?.text ?? '';
            const tier: MemoryTier = filePath.endsWith('MEMORY.md') ? 'long-term' : 'daily';
            hits.push({
              file: filePath,
              line: obj.data.line_number,
              snippet: (obj.data.lines?.text ?? '').trim(),
              tier,
            });
          }
        } catch {
          // skip non-JSON lines
        }
      }
      resolve(hits);
    });
  });
}
