// Owns explicit network provisioning and integrity verification for immutable local model assets.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupVerifiedAssetTemporaryFiles,
  downloadVerifiedAsset,
  inspectVerifiedAssetFile,
} from '@littlesheep/safety/verified-asset';
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
    const status = await inspectVerifiedAssetFile(path, file);
    if (status === 'missing') missing.push(file.path);
    else if (status === 'invalid') invalid.push(file.path);
    else totalBytes += file.bytes;
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
    if (await inspectVerifiedAssetFile(destination, file) === 'valid') {
      await cleanupVerifiedAssetTemporaryFiles(destination, options.signal);
      completedBytes += file.bytes;
      options.onProgress?.({ file: file.path, completedBytes, totalBytes });
      continue;
    }
    const url = new URL(`${spec.repository}/resolve/${spec.revision}/${file.path}`, remoteHost).toString();
    await downloadVerifiedAsset({
      fetchFn,
      url,
      destination,
      expected: file,
      signal: options.signal,
      label: 'Model asset',
      onBytes: (written) => {
        options.onProgress?.({ file: file.path, completedBytes: completedBytes + written, totalBytes });
      },
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
