// @littlesheep/cli — commands/memory.ts
// `littlesheep memory rollback` — restore memory files from pre-write snapshots.
//
// Rollback bypasses SafeMemoryStore (historical content is trusted — never
// re-validated for injection) but DOES go through SnapshotMemoryStore so the
// rollback itself is snapshotted and reversible (undo an undo).

import * as readline from 'node:readline/promises';
import { MemoryStore } from '@littlesheep/memory-core';
import {
  SnapshotMemoryStore,
  SnapshotIndex,
  type SnapshotEntry,
} from '@littlesheep/snapshot';

export interface MemoryRollbackFlags {
  list?: boolean;
  last?: boolean;
  to?: string;
  lastLongTerm?: boolean;
  lastDaily?: string;
  yes?: boolean;
}

export const ROLLBACK_USAGE = `Usage: littlesheep memory rollback [options]

  Restore memory files from pre-write snapshots.

  Options:
    --list                 List all snapshots (newest first)
    --last                 Roll back the most recent write (any tier)
    --last-long-term       Roll back the most recent MEMORY.md write
    --last-daily <date>    Roll back the most recent write to memory/<date>.md
    --to <id>              Roll back to a specific snapshot id (from --list)
    -y, --yes              Skip confirmation prompt

  Rollback overwrites the current file with its pre-write snapshot content.
  The rollback itself is snapshotted, so it can be undone with another --last.`;

/** Parse rollback flags from argv (the slice after 'memory rollback'). */
export function parseMemoryRollbackFlags(argv: string[]): MemoryRollbackFlags {
  const out: MemoryRollbackFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--list') out.list = true;
    else if (a === '--last') out.last = true;
    else if (a === '--last-long-term') out.lastLongTerm = true;
    else if (a === '--to') out.to = argv[++i] ?? '';
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a === '--last-daily') out.lastDaily = argv[++i] ?? '';
    else if (a.startsWith('--last-daily=')) out.lastDaily = a.slice('--last-daily='.length);
    else if (a === '--yes' || a === '-y') out.yes = true;
  }
  return out;
}

export interface RunMemoryRollbackOptions {
  /** Data root (dirs.root) — base MemoryStore rootDir. */
  dataRoot: string;
  /** Backups dir (dirs.backups) — snapshot index + content files. */
  backupsDir: string;
  flags: MemoryRollbackFlags;
  /** Injectable confirmation prompt (default: readline if TTY, else abort). */
  confirm?: (entry: SnapshotEntry) => Promise<boolean>;
  /** Injectable stdout (tests). */
  out?: (msg: string) => void;
  /** Injectable stderr (tests). */
  err?: (msg: string) => void;
}

/** Default confirm: readline prompt if stdin is a TTY, else require --yes. */
async function defaultConfirm(entry: SnapshotEntry): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive: refuse unless --yes was passed.
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const where = entry.tier === 'daily' ? ` ${entry.date ?? ''}` : '';
    const answer = await rl.question(
      `Rollback ${entry.tier}${where} to snapshot ${entry.id}? [y/N] `,
    );
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

/**
 * Execute a memory rollback command.
 * Sets process.exitCode on failure (does not throw).
 */
export async function runMemoryRollback(opts: RunMemoryRollbackOptions): Promise<void> {
  const index = new SnapshotIndex({ snapshotDir: opts.backupsDir });
  const out = opts.out ?? ((m: string) => process.stdout.write(m));
  const err = opts.err ?? ((m: string) => process.stderr.write(m));

  // --list: print all snapshots and exit.
  if (opts.flags.list) {
    const entries = await index.listNewestFirst();
    if (entries.length === 0) {
      out('No snapshots found.\n');
      return;
    }
    out('Snapshots (newest first):\n');
    for (const e of entries) {
      const where = e.date ? ` ${e.date}` : '';
      out(`  ${e.id}  ${e.tier}${where}  ${e.operation}  ${e.ts}\n`);
    }
    out(`(${entries.length} total)\n`);
    return;
  }

  // Resolve the target snapshot.
  let entry: SnapshotEntry | null = null;
  if (opts.flags.to) {
    entry = await index.get(opts.flags.to);
  } else if (opts.flags.lastLongTerm) {
    entry = await index.getLatest('long-term');
  } else if (opts.flags.lastDaily) {
    entry = await index.getLatest('daily', opts.flags.lastDaily);
  } else if (opts.flags.last) {
    entry = await index.getLatest();
  } else {
    err(ROLLBACK_USAGE + '\n');
    process.exitCode = 2;
    return;
  }

  if (!entry) {
    err('No matching snapshot found.\n');
    err('Use --list to see available snapshots.\n');
    process.exitCode = 1;
    return;
  }

  // Read the pre-write content.
  let content: string;
  try {
    content = await index.readContent(entry);
  } catch (e) {
    err(`Cannot read snapshot content: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Confirm (unless --yes).
  if (!opts.flags.yes) {
    const confirmFn = opts.confirm ?? defaultConfirm;
    const ok = await confirmFn(entry);
    if (!ok) {
      out('Aborted. (Pass --yes to skip confirmation.)\n');
      return;
    }
  }

  // Restore: write the before-content back via SnapshotMemoryStore(base).
  //   - Snapshot wraps base so the rollback itself is snapshotted (reversible).
  //   - Safe is deliberately SKIPPED: historical content is trusted.
  const baseStore = new MemoryStore({ rootDir: opts.dataRoot });
  const snapStore = new SnapshotMemoryStore(baseStore, { snapshotDir: opts.backupsDir });

  if (entry.tier === 'long-term') {
    await snapStore.writeLongTerm(content);
  } else if (entry.tier === 'daily' && entry.date) {
    await snapStore.writeDaily(entry.date, content);
  } else {
    err(`Snapshot ${entry.id} is missing a date for daily tier.\n`);
    process.exitCode = 1;
    return;
  }

  const where = entry.date ? ` ${entry.date}` : '';
  out(`Rolled back ${entry.tier}${where} to snapshot ${entry.id}.\n`);
}
