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
//
// The *fresh process* part is the one that moved. `initialize()` used to parse
// every historical record before the Runner could be published, which made the
// send control's enable time scale with the data root (paired measurement on a
// 300-command inbox: ~210 ms of parsing against ~8 ms for the listing). A
// completed command cannot be claimed, requeued or recovered, so the startup pass
// reads only the names and defers the contents of the terminal records; those are
// read exactly once, by whichever full read comes first, or by the after-publish
// warm pass. `readInboxCommands` is that whole policy, kept here so the store
// itself stays about commands rather than about caching.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DurableInboxCommand } from '@littlesheep/types';
import { hashParts, mapWithConcurrency } from './durable-store-utils.js';

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

/** Command files whose contents a startup pass deliberately did not read. */
export interface DeferredInboxCommands {
  files: Map<string, FileStamp>;
}

/** What one `readInboxCommands` call leaves behind for the next call. */
export interface InboxCommandState {
  commandCache?: InboxCommandCache;
  deferred?: DeferredInboxCommands;
}

export interface ReadInboxCommandsOptions {
  rootDir: string;
  /** The authoritative file list, in filename order. */
  files: readonly string[];
  state: InboxCommandState;
  /**
   * The store's own validated reader. `raw` is the text the scan already read, so
   * a file is never opened twice to decide and then to validate it. Omitted means
   * the dedicated reader is used, which is slower and only needed when the caller
   * cannot hand over the text it read.
   */
  readCommandFile: (name: string, raw?: string) => Promise<DurableInboxCommand>;
  /** The store's own error type, so callers keep seeing `kind: 'corrupt'`. */
  corrupt: (message: string) => Error;
  /** The startup pass: terminal records are deferred instead of parsed. */
  activeOnly?: boolean;
}

/** Deferred command files read at once by one warm pass; see `mapWithConcurrency`. */
const DEFERRED_READ_CONCURRENCY = 16;

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

/**
 * The authoritative command set, as a validated in-memory list.
 *
 * A cache with deferred records is never returned: it is a partial view, and only
 * the deferred read here may make it authoritative. Every path that is not
 * `activeOnly` therefore leaves with a complete set, so no caller can observe a
 * command list that silently lost a record.
 */
export async function readInboxCommands(options: ReadInboxCommandsOptions): Promise<DurableInboxCommand[]> {
  const { files, rootDir, state } = options;
  const cached = state.commandCache;
  const cacheComplete = cached !== undefined
    && state.deferred === undefined
    && cached.stamps.size === files.length
    && files.every((name) => cached.stamps.has(name));
  if (cacheComplete && await mutableStampsUnchanged(rootDir, cached)) return cached.commands;
  if (state.deferred !== undefined) {
    const base = state.commandCache;
    if (!base) {
      // The startup scan produced deferred names but no cache to fold them into;
      // the full read below is the one that can still answer.
      state.deferred = undefined;
    } else {
      state.commandCache = await loadDeferred(rootDir, files, base, state.deferred, options);
      state.deferred = undefined;
      return state.commandCache.commands;
    }
  }
  if (options.activeOnly) {
    const startup = await scanActive(rootDir, files, options);
    if (startup) {
      state.commandCache = startup.cache;
      state.deferred = startup.deferred;
      return startup.cache.commands;
    }
  }
  return readEveryCommand(rootDir, files, options);
}

function readEveryCommand(
  rootDir: string,
  files: readonly string[],
  options: ReadInboxCommandsOptions,
): Promise<DurableInboxCommand[]> {
  return (async () => {
    const commands: DurableInboxCommand[] = [];
    const stamps = new Map<string, FileStamp>();
    const mutable = new Set<string>();
    const commandIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const name of files) {
      const command = await options.readCommandFile(name);
      assertUniqueCommand(command, commandIds, idempotencyKeys, options.corrupt);
      commands.push(command);
      const stamp = await statInboxFile(rootDir, name);
      if (!stamp) {
        // The file vanished under the read; the caller must not treat this list
        // as cached, and the next call resolves it from disk again.
        options.state.commandCache = undefined;
        return commands;
      }
      stamps.set(name, stamp);
      if (command.status !== 'completed') mutable.add(name);
    }
    options.state.commandCache = { commands, stamps, mutable };
    return commands;
  })();
}

/**
 * Startup scan. Returns undefined when the directory changed between the listing
 * and the scan, which sends the caller to the full read instead.
 *
 * The per-file work overlaps: on a 300-command inbox the sequential version cost
 * ~100 ms of round trips (a stat plus a read per file), and the same work bounded
 * at 16 in flight costs ~11 ms. Only a status is needed to defer a file, so the
 * text read for that decision is handed to `validateDeferredCommand` instead of
 * being read a second time.
 */
async function scanActive(
  rootDir: string,
  files: readonly string[],
  options: ReadInboxCommandsOptions,
): Promise<{ cache: InboxCommandCache; deferred: DeferredInboxCommands | undefined } | undefined> {
  const scanned = await mapWithConcurrency(files, DEFERRED_READ_CONCURRENCY, async (name) => {
    const file = join(rootDir, name);
    let raw: string;
    let stamp: FileStamp;
    try {
      const details = await stat(file);
      stamp = { size: details.size, mtimeMs: details.mtimeMs };
      raw = await readFile(file, 'utf8');
    } catch {
      // The listing and the directory disagree; the full read resolves it.
      return undefined;
    }
    const status = readRawStatus(raw);
    if (status === 'completed' || status === 'failed') {
      return { name, stamp, command: undefined };
    }
    return {
      name,
      stamp,
      command: await options.readCommandFile(name, raw),
    };
  });
  const commands: DurableInboxCommand[] = [];
  const stamps = new Map<string, FileStamp>();
  const mutable = new Set<string>();
  const deferredFiles = new Map<string, FileStamp>();
  const commandIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const entry of scanned) {
    if (!entry) return undefined;
    if (!entry.command) {
      deferredFiles.set(entry.name, entry.stamp);
      continue;
    }
    assertUniqueCommand(entry.command, commandIds, idempotencyKeys, options.corrupt);
    commands.push(entry.command);
    stamps.set(entry.name, entry.stamp);
    if (entry.command.status !== 'completed') mutable.add(entry.name);
  }
  return {
    cache: { commands, stamps, mutable },
    deferred: deferredFiles.size === 0 ? undefined : { files: deferredFiles },
  };
}

async function loadDeferred(
  rootDir: string,
  files: readonly string[],
  cache: InboxCommandCache,
  deferred: DeferredInboxCommands,
  options: ReadInboxCommandsOptions,
): Promise<InboxCommandCache> {
  const names = files.filter((name) => deferred.files.has(name));
  if (names.length === 0) return cache;
  const loaded = await mapWithConcurrency(names, DEFERRED_READ_CONCURRENCY, async (name) => ({
    name,
    command: await options.readCommandFile(name),
    stamp: deferred.files.get(name) ?? await statInboxFile(rootDir, name),
  }));
  const commands = [...cache.commands];
  const stamps = new Map(cache.stamps);
  const mutable = new Set(cache.mutable);
  const commandIds = new Set(commands.map((command) => command.commandId));
  const idempotencyKeys = new Set(commands.map((command) => command.idempotencyKey));
  for (const { name, command, stamp } of loaded) {
    assertUniqueCommand(command, commandIds, idempotencyKeys, options.corrupt);
    commands.push(command);
    if (stamp) stamps.set(name, stamp);
    if (command.status !== 'completed') mutable.add(name);
  }
  commands.sort((left, right) => hashParts(left.commandId).localeCompare(hashParts(right.commandId)));
  return { commands, stamps, mutable };
}

/**
 * The status field of a raw record, or undefined when it cannot be read.
 *
 * An unreadable status is treated as terminal: the records a starting process can
 * act on are the ones it can *prove* it can act on, and the full read that later
 * touches a deferred file validates it and fails closed there.
 */
function readRawStatus(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as { status?: unknown }).status;
  } catch {
    return undefined;
  }
}

function assertUniqueCommand(
  command: DurableInboxCommand,
  commandIds: Set<string>,
  idempotencyKeys: Set<string>,
  corrupt: (message: string) => Error,
): void {
  if (commandIds.has(command.commandId)) throw corrupt(`duplicate command id: ${command.commandId}`);
  if (idempotencyKeys.has(command.idempotencyKey)) throw corrupt(`duplicate inbox idempotency key: ${command.idempotencyKey}`);
  commandIds.add(command.commandId);
  idempotencyKeys.add(command.idempotencyKey);
}
