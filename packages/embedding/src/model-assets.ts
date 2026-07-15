// Owns explicit network provisioning and integrity verification for immutable local model assets.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getLocalEmbeddingModel, type LocalEmbeddingModelId, type LocalEmbeddingModelSpec } from './model-registry.js';

export interface LocalEmbeddingModelVerification {
  available: boolean;
  modelRoot: string;
  missing: string[];
  invalid: string[];
  totalBytes: number;
}

export interface ProvisionLocalEmbeddingModelOptions {
  model: LocalEmbeddingModelId;
  modelRootDir: string;
  remoteHost?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: { file: string; completedBytes: number; totalBytes: number }) => void;
}

export async function verifyLocalEmbeddingModel(
  model: LocalEmbeddingModelId,
  modelRootDir: string,
): Promise<LocalEmbeddingModelVerification> {
  const spec = getLocalEmbeddingModel(model);
  const revisionRootPath = revisionRoot(modelRootDir, spec);
  const repositoryRoot = join(revisionRootPath, ...spec.repository.split('/'));
  const missing: string[] = [];
  const invalid: string[] = [];
  let totalBytes = 0;
  for (const file of spec.files) {
    const path = join(repositoryRoot, ...file.path.split('/'));
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size !== file.bytes) {
        invalid.push(file.path);
        continue;
      }
      const sha256 = await hashFile(path);
      if (sha256 !== file.sha256) {
        invalid.push(file.path);
        continue;
      }
      totalBytes += info.size;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') missing.push(file.path);
      else throw error;
    }
  }
  return {
    available: missing.length === 0 && invalid.length === 0,
    modelRoot: revisionRootPath,
    missing,
    invalid,
    totalBytes,
  };
}

export async function provisionLocalEmbeddingModel(
  options: ProvisionLocalEmbeddingModelOptions,
): Promise<LocalEmbeddingModelVerification> {
  const spec = getLocalEmbeddingModel(options.model);
  const fetchFn = options.fetchFn ?? fetch;
  const remoteHost = ensureTrailingSlash(options.remoteHost ?? 'https://huggingface.co');
  const revisionRootPath = revisionRoot(options.modelRootDir, spec);
  const repositoryRoot = join(revisionRootPath, ...spec.repository.split('/'));
  await mkdir(repositoryRoot, { recursive: true });
  const totalBytes = spec.files.reduce((sum, file) => sum + file.bytes, 0);
  let completedBytes = 0;

  for (const file of spec.files) {
    if (options.signal?.aborted) throw abortError();
    const destination = join(repositoryRoot, ...file.path.split('/'));
    if (await fileMatches(destination, file.bytes, file.sha256)) {
      completedBytes += file.bytes;
      options.onProgress?.({ file: file.path, completedBytes, totalBytes });
      continue;
    }
    const url = new URL(`${spec.repository}/resolve/${spec.revision}/${file.path}`, remoteHost).toString();
    await downloadVerifiedFile(fetchFn, url, destination, file.bytes, file.sha256, options.signal, (written) => {
      options.onProgress?.({ file: file.path, completedBytes: completedBytes + written, totalBytes });
    });
    completedBytes += file.bytes;
    options.onProgress?.({ file: file.path, completedBytes, totalBytes });
  }

  const verification = await verifyLocalEmbeddingModel(options.model, options.modelRootDir);
  if (!verification.available) {
    throw new Error(`Local embedding model verification failed: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
  await writeFile(join(revisionRootPath, 'model-manifest.json'), `${JSON.stringify({
    version: 1,
    model: spec.id,
    repository: spec.repository,
    revision: spec.revision,
    files: spec.files,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return verification;
}

export function localEmbeddingModelRoot(model: LocalEmbeddingModelId, modelRootDir: string): string {
  return revisionRoot(modelRootDir, getLocalEmbeddingModel(model));
}

async function downloadVerifiedFile(
  fetchFn: typeof fetch,
  url: string,
  destination: string,
  expectedBytes: number,
  expectedSha256: string,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetchFn(url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Model asset request failed: HTTP ${response.status} ${url}`);
    handle = await open(temporary, 'wx');
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let written = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      written += chunk.value.byteLength;
      if (written > expectedBytes) throw new Error(`Model asset exceeded expected size: ${url}`);
      hash.update(chunk.value);
      await writeAll(handle, chunk.value);
      onBytes(written);
    }
    if (written !== expectedBytes) throw new Error(`Model asset size mismatch for ${url}: ${written} != ${expectedBytes}`);
    const digest = hash.digest('hex');
    if (digest !== expectedSha256) throw new Error(`Model asset hash mismatch for ${url}`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(destination).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error('Model asset write made no progress.');
    offset += result.bytesWritten;
  }
}

async function fileMatches(path: string, bytes: number, sha256: string): Promise<boolean> {
  try {
    await access(path);
    const info = await stat(path);
    return info.isFile() && info.size === bytes && await hashFile(path) === sha256;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function revisionRoot(rootDir: string, spec: LocalEmbeddingModelSpec): string {
  return join(rootDir, spec.id, spec.revision);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function abortError(): Error {
  const error = new Error('Local embedding model provisioning was aborted.');
  error.name = 'AbortError';
  return error;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
