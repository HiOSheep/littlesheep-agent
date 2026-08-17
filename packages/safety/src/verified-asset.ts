import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_TEMP_DIRECTORY_ENTRIES = 4_096;
const LEGACY_TEMP_STALE_MS = 24 * 60 * 60 * 1_000;
const RENAME_RETRIES = 8;
const activeTemporaryPaths = new Set<string>();

export interface VerifiedAssetExpectation {
  bytes: number;
  sha256: string;
}

export type VerifiedAssetFileStatus = 'valid' | 'missing' | 'invalid';

export interface DownloadVerifiedAssetOptions {
  destination: string;
  expected: VerifiedAssetExpectation;
  url: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  label?: string;
  onBytes?: (bytes: number) => void;
}

/** Inspect one immutable asset without reading beyond its declared byte budget. */
export async function inspectVerifiedAssetFile(
  path: string,
  expected: VerifiedAssetExpectation,
): Promise<VerifiedAssetFileStatus> {
  const normalized = normalizeExpectation(expected);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== normalized.bytes) return 'invalid';
    const digest = await hashOpenFile(handle, normalized.bytes);
    const finalInfo = await handle.stat();
    return finalInfo.isFile()
      && finalInfo.size === normalized.bytes
      && digest === normalized.sha256
      ? 'valid'
      : 'invalid';
  } finally {
    await handle.close();
  }
}

/** Download, verify, sync, and atomically publish one immutable asset. */
export async function downloadVerifiedAsset(options: DownloadVerifiedAssetOptions): Promise<void> {
  const destination = resolve(options.destination);
  const expected = normalizeExpectation(options.expected);
  const label = options.label?.trim() || 'Asset';
  throwIfAborted(options.signal, `${label} download was aborted.`);
  await mkdir(dirname(destination), { recursive: true });
  await cleanupVerifiedAssetTemporaryFiles(destination, options.signal);
  throwIfAborted(options.signal, `${label} download was aborted.`);

  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const temporaryKey = resolve(temporary);
  activeTemporaryPaths.add(temporaryKey);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetchFn ?? fetch)(options.url, {
      signal: options.signal,
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      throw new Error(`${label} request failed: HTTP ${response.status} ${options.url}`);
    }

    handle = await open(temporary, 'wx');
    reader = response.body.getReader();
    const hash = createHash('sha256');
    let written = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      written += chunk.value.byteLength;
      if (written > expected.bytes) {
        throw new Error(`${label} exceeded expected size: ${options.url}`);
      }
      hash.update(chunk.value);
      await writeAll(handle, chunk.value, label);
      options.onBytes?.(written);
    }
    if (written !== expected.bytes) {
      throw new Error(`${label} size mismatch for ${options.url}: ${written} != ${expected.bytes}`);
    }
    if (hash.digest('hex') !== expected.sha256) {
      throw new Error(`${label} hash mismatch for ${options.url}`);
    }

    await handle.sync();
    await handle.close();
    handle = undefined;
    await publishVerifiedTemporaryFile(temporary, destination, expected);
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await unlinkWithRetry(temporary).catch(() => undefined);
    throw error;
  } finally {
    activeTemporaryPaths.delete(temporaryKey);
    try {
      reader?.releaseLock();
    } catch {
      // A failed stream may already have released its reader lock.
    }
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, expectedBytes));
  let offset = 0;
  while (offset < expectedBytes) {
    const length = Math.min(buffer.byteLength, expectedBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return '';
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error(`${label} write made no progress.`);
    offset += result.bytesWritten;
  }
}

async function publishVerifiedTemporaryFile(
  temporary: string,
  destination: string,
  expected: VerifiedAssetExpectation,
): Promise<void> {
  let delayMs = 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isRenameContention(error) || attempt === RENAME_RETRIES - 1) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
      delayMs = Math.min(delayMs * 2, 50);
    }
  }

  if (isRenameContention(lastError)) {
    try {
      if (await inspectVerifiedAssetFile(destination, expected) === 'valid') {
        await unlinkWithRetry(temporary);
        return;
      }
    } catch {
      // Preserve the original publication failure when the winner cannot be inspected.
    }
  }
  throw lastError;
}

/** Remove inactive temps left by an interrupted publisher without touching live writers. */
export async function cleanupVerifiedAssetTemporaryFiles(
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, 'Asset temporary-file cleanup was aborted.');
  const directory = dirname(destination);
  const escapedBase = escapeRegExp(basename(destination));
  const candidatePattern = new RegExp(`^${escapedBase}\\.(?:(\\d+)\\.)?([a-f0-9]{16})\\.tmp$`, 'i');
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  let visited = 0;
  for await (const entry of entries) {
    visited += 1;
    if (visited > MAX_TEMP_DIRECTORY_ENTRIES) {
      throw new Error(`Asset temporary-file cleanup exceeded ${MAX_TEMP_DIRECTORY_ENTRIES} directory entries.`);
    }
    throwIfAborted(signal, 'Asset temporary-file cleanup was aborted.');
    if (!entry.isFile()) continue;
    const match = candidatePattern.exec(entry.name);
    if (!match) continue;
    const candidate = resolve(join(directory, entry.name));
    if (activeTemporaryPaths.has(candidate)) continue;

    const ownerPid = match[1] === undefined ? undefined : Number(match[1]);
    if (ownerPid !== undefined) {
      if (ownerPid !== process.pid && isProcessAlive(ownerPid)) continue;
    } else {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(candidate);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (Date.now() - info.mtimeMs < LEGACY_TEMP_STALE_MS) continue;
    }
    await unlinkWithRetry(candidate);
  }
  throwIfAborted(signal, 'Asset temporary-file cleanup was aborted.');
}

function normalizeExpectation(expected: VerifiedAssetExpectation): VerifiedAssetExpectation {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0) {
    throw new Error('Verified asset byte length must be a positive safe integer.');
  }
  const sha256 = expected.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Verified asset SHA-256 must contain exactly 64 hexadecimal characters.');
  }
  return { bytes: expected.bytes, sha256 };
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  const error = new Error(message, { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code === 'EPERM' || code === 'EACCES';
  }
}

function isRenameContention(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES' || code === 'EEXIST';
}

async function unlinkWithRetry(path: string): Promise<void> {
  let delayMs = 2;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if ((code !== 'EPERM' && code !== 'EACCES') || attempt === RENAME_RETRIES - 1) throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
      delayMs = Math.min(delayMs * 2, 50);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
