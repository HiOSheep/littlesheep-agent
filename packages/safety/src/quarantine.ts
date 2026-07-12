// @littlesheep/safety — quarantine.ts
// QuarantineStore: persists rejected memory writes to individual files.
//
// Each rejection is its own file (YAML frontmatter + original text body) so
// rejections can't cross-contaminate. File names are Windows-safe (colons and
// dots in ISO timestamps are replaced with dashes).
//
// Layout:  <rootDir>/<subdir>/<YYYYMMDD-HHmmss-SSS>-<source>.md

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface QuarantineEntry {
  /** ISO timestamp when the rejection happened. */
  timestamp: string;
  /** Coarse source: 'runtime' | 'repo' | ... */
  source: string;
  /** Optional sub-source (repo name, stage name). */
  provenance?: string;
  /** Human-readable rejection reason. */
  reason: string;
  /** Pattern id that triggered rejection, or 'too_long'. */
  matchedPatternId?: string;
  /** Original (un-sanitized) text that was rejected. */
  originalText: string;
  /** Populated when read back from disk (basename). */
  fileName?: string;
}

export interface QuarantineStoreOptions {
  rootDir: string;
  /** Subdirectory under rootDir. Default 'quarantine'. */
  subdir?: string;
}

/** Replace chars that are invalid in Windows filenames. */
function windowsSafeFileName(s: string): string {
  return s
    .replace(/[:.]/g, '-') // ISO timestamps contain ':' and '.'
    .replace(/[^a-zA-Z0-9_+.-]/g, '-');
}

export class QuarantineStore {
  private readonly dir: string;

  constructor(opts: QuarantineStoreOptions) {
    this.dir = join(opts.rootDir, opts.subdir ?? 'quarantine');
  }

  /** The resolved quarantine directory (for diagnostics). */
  get directory(): string {
    return this.dir;
  }

  /**
   * Write a quarantine entry to its own file.
   * Returns the file name (basename) on success.
   */
  async write(entry: QuarantineEntry): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const ts = windowsSafeFileName(entry.timestamp);
    const source = windowsSafeFileName(entry.source);
    const fileName = `${ts}-${source}.md`;
    const filePath = join(this.dir, fileName);

    const lines: string[] = [
      '---',
      `timestamp: ${entry.timestamp}`,
      `source: ${entry.source}`,
    ];
    if (entry.provenance) lines.push(`provenance: ${entry.provenance}`);
    lines.push(`reason: ${entry.reason}`);
    if (entry.matchedPatternId) lines.push(`matchedPatternId: ${entry.matchedPatternId}`);
    lines.push('---', '');

    const content = lines.join('\n') + entry.originalText + '\n';
    await writeFile(filePath, content, 'utf8');
    return fileName;
  }

  /** List all quarantine entries, newest-first (file-name sort). */
  async list(): Promise<QuarantineEntry[]> {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir);
    const files = entries.filter((f) => f.endsWith('.md')).sort().reverse();
    const result: QuarantineEntry[] = [];
    for (const f of files) {
      const entry = await this.read(f);
      if (entry) result.push(entry);
    }
    return result;
  }

  /** Read a single quarantine entry by file name (basename). Returns null if missing/unparseable. */
  async read(fileName: string): Promise<QuarantineEntry | null> {
    const filePath = join(this.dir, fileName);
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, 'utf8');
    return parseQuarantineFile(raw, fileName);
  }
}

/** Parse a quarantine file's YAML frontmatter + body into an entry. */
export function parseQuarantineFile(raw: string, fileName: string): QuarantineEntry | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const frontmatter = match[1];
  const body = match[2];

  const entry: QuarantineEntry = {
    timestamp: '',
    source: '',
    reason: '',
    originalText: body.replace(/\n$/, ''),
    fileName,
  };

  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const key = m[1];
    const value = m[2];
    switch (key) {
      case 'timestamp':
        entry.timestamp = value;
        break;
      case 'source':
        entry.source = value;
        break;
      case 'provenance':
        entry.provenance = value;
        break;
      case 'reason':
        entry.reason = value;
        break;
      case 'matchedPatternId':
        entry.matchedPatternId = value;
        break;
    }
  }

  if (!entry.timestamp || !entry.source || !entry.reason) {
    return null;
  }
  return entry;
}
