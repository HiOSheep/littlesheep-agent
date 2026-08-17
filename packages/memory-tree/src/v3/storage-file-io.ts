// Shared bounded file discovery, reads, and quarantine mechanics for Memory v3 stores.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { durableAtomicWriteJson } from './durable-json.js';

const READ_CHUNK_BYTES = 64 * 1024;

export interface CollectStorageFilesOptions {
  root: string;
  suffix: string;
  maximumFiles: number;
  limitMessage: (maximumFiles: number) => string;
  signal?: AbortSignal;
}

export async function collectStorageFiles(options: CollectStorageFilesOptions): Promise<string[]> {
  const pending = [options.root];
  const files: string[] = [];
  while (pending.length > 0) {
    throwIfAborted(options.signal);
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(options.suffix)) files.push(path);
      if (files.length > options.maximumFiles) {
        throw new Error(options.limitMessage(options.maximumFiles));
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function readBoundedJsonFile<T>(
  path: string,
  maximumBytes: number,
  assertBytes: (actual: number, maximum: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const bytes = await readBoundedFile(path, maximumBytes, assertBytes, signal);
  return JSON.parse(bytes.toString('utf8')) as T;
}

export async function readBoundedFile(
  path: string,
  maximumBytes: number,
  assertBytes: (actual: number, maximum: number) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`Invalid Memory v3 storage file size limit: ${maximumBytes}`);
  }
  throwIfAborted(signal);
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    assertWithinReadBudget(file.size, maximumBytes, assertBytes);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const chunkBytes = Math.min(READ_CHUNK_BYTES, maximumBytes - total + 1);
      const chunk = Buffer.allocUnsafe(Math.max(1, chunkBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      assertWithinReadBudget(total, maximumBytes, assertBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export interface QuarantineStorageFileOptions {
  source: string;
  destinationDir: string;
  details: Readonly<Record<string, unknown>>;
  now: () => Date;
}

export async function quarantineStorageFile(options: QuarantineStorageFileOptions): Promise<string> {
  await mkdir(options.destinationDir, { recursive: true });
  const suffix = `${timestamp(options.now())}-${randomBytes(4).toString('hex')}`;
  const destination = join(options.destinationDir, `${basename(options.source)}.${suffix}`);
  await rename(options.source, destination);
  await durableAtomicWriteJson(`${destination}.reason.json`, {
    ...options.details,
    version: 1,
    quarantinedAt: options.now().toISOString(),
  });
  return destination;
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function assertWithinReadBudget(
  actual: number,
  maximum: number,
  assertBytes: (actual: number, maximum: number) => void,
): void {
  assertBytes(actual, maximum);
  if (actual > maximum) {
    throw new Error(`Memory v3 storage file exceeds the ${maximum} byte safety limit.`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Memory v3 file scan was aborted.');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
