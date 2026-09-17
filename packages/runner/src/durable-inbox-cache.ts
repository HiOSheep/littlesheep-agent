// Verified inbox cache helpers.
//
// The inbox is one flat directory and the durable ingress path reads it several
// times per event (enqueue, claim, complete). Re-reading and re-parsing every
// command on each call made strict-path ingress O(runs) instead of O(active).
// A cached prefix is trusted while the listing matches and every *mutable*
// command file still carries its recorded size/mtime. Completed commands are
// terminal by this store's contract (complete/fail/enqueue all refuse to rewrite
// them), so presence plus listing count is enough for them; a fresh process
// still re-validates everything from disk.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableInboxCommand } from '@littlesheep/types';
import { hashParts } from './durable-store-utils.js';

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface InboxCommandCache {
  commands: DurableInboxCommand[];
  stamps: Map<string, FileStamp>;
  /** File names whose command may still be rewritten in place. */
  mutable: Set<string>;
}

export async function statInboxFile(rootDir: string, name: string): Promise<FileStamp | undefined> {
  try {
    const details = await stat(join(rootDir, name));
    return { size: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return undefined;
  }
}

/** True when every mutable command file still matches its recorded stamp. */
export async function mutableStampsUnchanged(
  rootDir: string,
  cache: InboxCommandCache,
): Promise<boolean> {
  const names = [...cache.mutable];
  const matches = await Promise.all(names.map(async (name) => {
    const cached = cache.stamps.get(name);
    const current = await statInboxFile(rootDir, name);
    return Boolean(cached && current && current.size === cached.size && current.mtimeMs === cached.mtimeMs);
  }));
  return matches.every(Boolean);
}

/** Record a written command in an existing cache, keeping filename order. */
export function rememberInboxCommand(
  cache: InboxCommandCache,
  fileName: string,
  command: DurableInboxCommand,
  stamp: FileStamp,
): InboxCommandCache {
  const index = cache.commands.findIndex((entry) => entry.commandId === command.commandId);
  const commands = index >= 0
    ? cache.commands.map((entry, position) => (position === index ? command : entry))
    : [...cache.commands, command];
  // Keep the cached order identical to the on-disk filename (hash) order.
  commands.sort((left, right) => hashParts(left.commandId).localeCompare(hashParts(right.commandId)));
  const mutable = new Set(cache.mutable);
  if (command.status === 'completed') mutable.delete(fileName);
  else mutable.add(fileName);
  const stamps = new Map(cache.stamps);
  stamps.set(fileName, stamp);
  return { commands, stamps, mutable };
}
