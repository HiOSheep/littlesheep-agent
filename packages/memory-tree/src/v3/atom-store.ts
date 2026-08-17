// Owns durable Memory v3 atom files, lightweight headers, hierarchy validation, and quarantine.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { CreateMemoryAtomInput, MemoryAtom, MemoryAtomPatch } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';
import { parseMemoryAtom } from './validation.js';

const DEFAULT_MAX_ATOM_BYTES = 2_500_000;
const DEFAULT_MAX_SCAN_FILES = 100_000;
const DEFAULT_SCAN_CONCURRENCY = 32;

export interface MemoryAtomStoreOptions {
  dataDir: string;
  now?: () => Date;
  maxAtomBytes?: number;
  maxScanFiles?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface MemoryAtomScanIssue {
  path: string;
  category: 'corrupt' | 'orphan' | 'duplicate' | 'misplaced';
  message: string;
  atomId?: string;
  quarantinePath?: string;
}

export interface MemoryAtomScanResult {
  entries: MemoryAtomIndexEntry[];
  issues: MemoryAtomScanIssue[];
  scannedFiles: number;
}

export interface MemoryAtomIndexEntry {
  id: string;
  path: string;
  revision: number;
  branch: MemoryAtom['branch'];
  parentId?: string;
  scope: MemoryAtom['scope'];
  scopeKey?: string;
  status: MemoryAtom['status'];
  contentHash: string;
}

export class MemoryAtomConflictError extends Error {
  constructor(readonly atomId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Memory atom ${atomId} revision conflict: expected ${expectedRevision}, found ${actualRevision}.`);
    this.name = 'MemoryAtomConflictError';
  }
}

export class MemoryAtomStore {
  readonly rootDir: string;
  readonly atomsDir: string;
  readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxAtomBytes: number;
  private readonly maxScanFiles: number;
  private readonly log?: MemoryAtomStoreOptions['log'];
  private readonly index = new Map<string, MemoryAtomIndexEntry>();
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryAtomStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3');
    this.atomsDir = join(this.rootDir, 'atoms');
    this.quarantineDir = join(this.rootDir, 'quarantine');
    this.now = options.now ?? (() => new Date());
    this.maxAtomBytes = options.maxAtomBytes ?? DEFAULT_MAX_ATOM_BYTES;
    this.maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.log = options.log;
  }

  async initialize(): Promise<MemoryAtomScanResult> {
    return this.exclusive(async () => {
      await mkdir(this.atomsDir, { recursive: true });
      await mkdir(this.quarantineDir, { recursive: true });
      const result = await this.scanInternal(true);
      this.replaceIndex(result.entries);
      this.initialized = true;
      return result;
    });
  }

  async scan(options: { quarantine?: boolean } = {}): Promise<MemoryAtomScanResult> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const result = await this.scanInternal(options.quarantine ?? true);
      this.replaceIndex(result.entries);
      return result;
    });
  }

  async create(input: CreateMemoryAtomInput): Promise<MemoryAtom> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      if (this.index.has(input.id)) throw new Error(`Memory atom already exists: ${input.id}`);
      const timestamp = this.validNow(input.updatedAt ?? input.createdAt);
      const atomWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
        ...structuredClone(input),
        version: 3,
        revision: 1,
        createdAt: this.validNow(input.createdAt ?? timestamp),
        updatedAt: timestamp,
      };
      this.validateParent(atomWithoutHash);
      const atom = parseMemoryAtom({
        ...atomWithoutHash,
        contentHash: memoryAtomContentHash(atomWithoutHash),
      });
      const path = this.pathFor(atom.id, atom.branch);
      await durableAtomicWriteJson(path, atom);
      this.index.set(atom.id, atomIndexEntry(atom, path));
      return structuredClone(atom);
    });
  }

  async read(atomId: string): Promise<MemoryAtom | undefined> {
    await this.ensureInitialized();
    const indexed = this.index.get(atomId);
    return indexed ? readAndVerifyAtom(indexed.path, this.maxAtomBytes) : undefined;
  }

  async list(): Promise<MemoryAtom[]> {
    await this.ensureInitialized();
    const atoms: MemoryAtom[] = [];
    for await (const atom of this.iterateAtoms()) atoms.push(atom);
    return atoms;
  }

  async *iterateAtoms(): AsyncGenerator<MemoryAtom> {
    await this.ensureInitialized();
    const entries = [...this.index.values()].sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of entries) yield await readAndVerifyAtom(entry.path, this.maxAtomBytes);
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.index.size;
  }

  async update(atomId: string, expectedRevision: number, patch: MemoryAtomPatch): Promise<MemoryAtom> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const indexed = this.index.get(atomId);
      if (!indexed) throw new Error(`Memory atom not found: ${atomId}`);
      if (indexed.revision !== expectedRevision) {
        throw new MemoryAtomConflictError(atomId, expectedRevision, indexed.revision);
      }
      const current = await readAndVerifyAtom(indexed.path, this.maxAtomBytes);
      assertPatchDoesNotChangeBoundary(patch);
      const nextWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
        ...current,
        ...structuredClone(patch),
        revision: current.revision + 1,
        updatedAt: this.validNow(),
      };
      delete (nextWithoutHash as Partial<MemoryAtom>).contentHash;
      this.validateParent(nextWithoutHash, atomId);
      const next = parseMemoryAtom({
        ...nextWithoutHash,
        contentHash: memoryAtomContentHash(nextWithoutHash),
      });
      await durableAtomicWriteJson(indexed.path, next);
      this.index.set(atomId, atomIndexEntry(next, indexed.path));
      return structuredClone(next);
    });
  }

  async archive(atomId: string, expectedRevision: number): Promise<MemoryAtom> {
    return this.update(atomId, expectedRevision, { status: 'archived' });
  }

  async restore(atomId: string, expectedRevision: number): Promise<MemoryAtom> {
    return this.update(atomId, expectedRevision, { status: 'active' });
  }

  pathFor(atomId: string, branch: MemoryAtom['branch']): string {
    const digest = atomFileDigest(atomId);
    return join(this.atomsDir, branch, digest.slice(0, 2), `${digest}.memory.json`);
  }

  relativePathFor(atomId: string): string | undefined {
    const indexed = this.index.get(atomId);
    return indexed ? relative(this.rootDir, indexed.path).replace(/\\/gu, '/') : undefined;
  }

  private async scanInternal(quarantine: boolean): Promise<MemoryAtomScanResult> {
    const paths = await collectAtomFiles(this.atomsDir, this.maxScanFiles);
    const issues: MemoryAtomScanIssue[] = [];
    const byId = new Map<string, MemoryAtomIndexEntry>();
    const loaded = await concurrentMap(paths, DEFAULT_SCAN_CONCURRENCY, async (path) => {
      try {
        const bytes = await readFile(path);
        if (bytes.byteLength > this.maxAtomBytes) throw new Error(`atom exceeds ${this.maxAtomBytes} bytes`);
        const parsed = parseMemoryAtom(JSON.parse(bytes.toString('utf8')) as unknown);
        if (memoryAtomContentHash(parsed) !== parsed.contentHash) throw new Error('content hash mismatch');
        return { ok: true, entry: atomIndexEntry(parsed, path) } as const;
      } catch (error) {
        return { ok: false, path, error: errorMessage(error) } as const;
      }
    });
    for (const candidate of loaded) {
      if (!candidate.ok) {
        issues.push(await this.issue(candidate.path, 'corrupt', candidate.error, undefined, quarantine));
        continue;
      }
      const { entry } = candidate;
      if (!samePath(entry.path, this.pathFor(entry.id, entry.branch))) {
        issues.push(await this.issue(entry.path, 'misplaced', 'atom path does not match branch/id shard', entry.id, quarantine));
        continue;
      }
      if (byId.has(entry.id)) {
        issues.push(await this.issue(entry.path, 'duplicate', 'duplicate atom id', entry.id, quarantine));
        continue;
      }
      byId.set(entry.id, entry);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [atomId, entry] of [...byId]) {
        const reason = invalidHierarchyReason(entry, byId);
        if (!reason) continue;
        issues.push(await this.issue(entry.path, 'orphan', reason, atomId, quarantine));
        byId.delete(atomId);
        changed = true;
      }
    }

    if (issues.length > 0) {
      this.log?.('warn', `memory-v3: scan isolated ${issues.length} invalid atom file(s)`, issues);
    }
    return {
      entries: [...byId.values()].map((entry) => structuredClone(entry)),
      issues,
      scannedFiles: paths.length,
    };
  }

  private async issue(
    path: string,
    category: MemoryAtomScanIssue['category'],
    message: string,
    atomId: string | undefined,
    quarantine: boolean,
  ): Promise<MemoryAtomScanIssue> {
    const issue: MemoryAtomScanIssue = { path, category, message, atomId };
    if (!quarantine) return issue;
    issue.quarantinePath = await this.quarantine(path, category, message, atomId);
    return issue;
  }

  private async quarantine(
    source: string,
    category: MemoryAtomScanIssue['category'],
    message: string,
    atomId?: string,
  ): Promise<string> {
    const destinationDir = join(this.quarantineDir, category);
    await mkdir(destinationDir, { recursive: true });
    const suffix = `${this.now().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(4).toString('hex')}`;
    const destination = join(destinationDir, `${basename(source)}.${suffix}`);
    await rename(source, destination);
    await durableAtomicWriteJson(`${destination}.reason.json`, {
      version: 1,
      category,
      message,
      atomId,
      originalPath: relative(this.rootDir, source).replace(/\\/gu, '/'),
      quarantinedAt: this.now().toISOString(),
    });
    return destination;
  }

  private validateParent(atom: Omit<MemoryAtom, 'contentHash'>, updatingId?: string): void {
    if (!atom.parentId) return;
    const parent = this.index.get(atom.parentId);
    if (!parent) throw new Error(`Memory atom parent does not exist: ${atom.parentId}`);
    if (parent.branch !== atom.branch) throw new Error('Memory atom parent must be in the same branch.');
    if (parent.scope !== atom.scope || parent.scopeKey !== atom.scopeKey) {
      throw new Error('Memory atom parent must be in the same scope and scopeKey.');
    }
    if (parent.status === 'tombstone') throw new Error('Memory atom parent cannot be a tombstone.');
    const targetId = updatingId ?? atom.id;
    let cursor: MemoryAtomIndexEntry | undefined = parent;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor.id === targetId) throw new Error(`Memory atom parent would create a cycle: ${targetId}`);
      if (visited.has(cursor.id)) throw new Error(`Existing memory hierarchy contains a cycle at ${cursor.id}`);
      visited.add(cursor.id);
      cursor = cursor.parentId ? this.index.get(cursor.parentId) : undefined;
    }
  }

  private replaceIndex(entries: MemoryAtomIndexEntry[]): void {
    this.index.clear();
    for (const entry of entries) this.index.set(entry.id, structuredClone(entry));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private validNow(candidate?: string): string {
    const value = candidate ?? this.now().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid atom timestamp: ${value}`);
    return value;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function memoryAtomContentHash(atom: Omit<MemoryAtom, 'contentHash'> | MemoryAtom): string {
  const { contentHash: _ignored, ...content } = atom as MemoryAtom;
  return sha256Canonical(content);
}

export function atomFileDigest(atomId: string): string {
  return createHash('sha256').update(atomId, 'utf8').digest('hex');
}

async function collectAtomFiles(root: string, limit: number): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.memory.json')) files.push(path);
      if (files.length > limit) throw new Error(`Memory atom scan exceeded the ${limit} file safety limit.`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function invalidHierarchyReason(atom: MemoryAtomIndexEntry, atoms: Map<string, MemoryAtomIndexEntry>): string | undefined {
  if (!atom.parentId) return undefined;
  const parent = atoms.get(atom.parentId);
  if (!parent) return `missing parent: ${atom.parentId}`;
  if (parent.branch !== atom.branch) return `parent branch mismatch: ${parent.branch}`;
  if (parent.scope !== atom.scope || parent.scopeKey !== atom.scopeKey) return 'parent scope mismatch';
  const visited = new Set([atom.id]);
  let cursor: MemoryAtomIndexEntry | undefined = parent;
  while (cursor) {
    if (visited.has(cursor.id)) return `hierarchy cycle at ${cursor.id}`;
    visited.add(cursor.id);
    cursor = cursor.parentId ? atoms.get(cursor.parentId) : undefined;
  }
  return undefined;
}

function atomIndexEntry(atom: MemoryAtom, path: string): MemoryAtomIndexEntry {
  return {
    id: atom.id,
    path,
    revision: atom.revision,
    branch: atom.branch,
    parentId: atom.parentId,
    scope: atom.scope,
    scopeKey: atom.scopeKey,
    status: atom.status,
    contentHash: atom.contentHash,
  };
}

async function readAndVerifyAtom(path: string, maxAtomBytes: number): Promise<MemoryAtom> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxAtomBytes) throw new Error(`atom exceeds ${maxAtomBytes} bytes`);
  const atom = parseMemoryAtom(JSON.parse(bytes.toString('utf8')) as unknown);
  if (memoryAtomContentHash(atom) !== atom.contentHash) throw new Error(`Memory atom content hash mismatch: ${atom.id}`);
  return atom;
}

function assertPatchDoesNotChangeBoundary(patch: MemoryAtomPatch): void {
  const value = patch as Record<string, unknown>;
  for (const key of ['version', 'id', 'revision', 'branch', 'scope', 'scopeKey', 'createdAt', 'updatedAt', 'contentHash']) {
    if (key in value) throw new Error(`Memory atom patch cannot change ${key}.`);
  }
}

async function concurrentMap<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
