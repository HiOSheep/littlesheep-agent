// @littlesheep/memory-core — store.ts
// File-based memory store: MEMORY.md (long-term) + memory/YYYY-MM-DD.md (daily).

import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStoreLike } from '@littlesheep/types';

export interface MemoryStoreOptions {
  /** Root data dir (e.g. ~/.littlesheep). */
  rootDir: string;
  /** Name of the long-term file (relative to rootDir). */
  longTermFile?: string;
  /** Name of the daily directory (relative to rootDir). */
  dailyDir?: string;
}

const DEFAULT_LONG_TERM = 'MEMORY.md';
const DEFAULT_DAILY_DIR = 'memory';

/** File-based memory store. */
export class MemoryStore implements MemoryStoreLike {
  private longTermFile: string;
  private dailyDir: string;

  constructor(opts: MemoryStoreOptions) {
    this.longTermFile = join(opts.rootDir, opts.longTermFile ?? DEFAULT_LONG_TERM);
    this.dailyDir = join(opts.rootDir, opts.dailyDir ?? DEFAULT_DAILY_DIR);
  }

  /** Path to the long-term MEMORY.md. */
  get longTermPath(): string {
    return this.longTermFile;
  }

  /** Path to the daily memory directory. */
  get dailyDirPath(): string {
    return this.dailyDir;
  }

  /** Read the long-term MEMORY.md content. Returns '' if missing. */
  async readLongTerm(): Promise<string> {
    if (!existsSync(this.longTermFile)) return '';
    return readFile(this.longTermFile, 'utf8');
  }

  /** Overwrite the long-term MEMORY.md. */
  async writeLongTerm(content: string): Promise<void> {
    await mkdir(join(this.longTermFile, '..'), { recursive: true });
    await writeFile(this.longTermFile, content, 'utf8');
  }

  /** Append to the long-term MEMORY.md. */
  async appendLongTerm(text: string): Promise<void> {
    await mkdir(join(this.longTermFile, '..'), { recursive: true });
    await appendFile(this.longTermFile, text + '\n', 'utf8');
  }

  /** Path to a daily memory file for a given date (YYYY-MM-DD). */
  dailyFile(date: string): string {
    return join(this.dailyDir, `${date}.md`);
  }

  /** Read a daily memory file. Returns '' if missing. */
  async readDaily(date: string): Promise<string> {
    const file = this.dailyFile(date);
    if (!existsSync(file)) return '';
    return readFile(file, 'utf8');
  }

  /** Append an insight to today's daily memory file. */
  async appendDaily(date: string, text: string): Promise<void> {
    const file = this.dailyFile(date);
    await mkdir(this.dailyDir, { recursive: true });
    // If file is new, add a header.
    if (!existsSync(file)) {
      await writeFile(file, `# Memory — ${date}\n\n`, 'utf8');
    }
    await appendFile(file, `- ${text}\n`, 'utf8');
  }

  /** Overwrite a daily memory file. */
  async writeDaily(date: string, content: string): Promise<void> {
    const file = this.dailyFile(date);
    await mkdir(this.dailyDir, { recursive: true });
    await writeFile(file, content, 'utf8');
  }

  /** List all daily memory dates (YYYY-MM-DD strings). */
  async listDailyDates(): Promise<string[]> {
    if (!existsSync(this.dailyDir)) return [];
    const entries = await readdir(this.dailyDir);
    return entries
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  }

  /** Get today's date as YYYY-MM-DD. */
  today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Format a Date to YYYY-MM-DD. */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Get the date N days ago as YYYY-MM-DD. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}
