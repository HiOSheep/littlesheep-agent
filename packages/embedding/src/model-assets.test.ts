import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testModel = vi.hoisted(() => ({
  id: 'bge-small-zh-v1.5' as const,
  repository: 'test/tiny-embedding',
  revision: 'fixed-revision',
  upstreamRepository: 'test/tiny-embedding',
  license: 'MIT' as const,
  dimensions: 2,
  dtype: 'q8' as const,
  queryPrefix: '',
  documentPrefix: '',
  maxCharacters: 128,
  quantizedOnnxBytes: 5,
  files: [{
    path: 'config.json',
    bytes: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }],
}));

vi.mock('./model-registry.js', () => ({
  getLocalEmbeddingModel: () => testModel,
}));

import { provisionLocalEmbeddingModel, verifyLocalEmbeddingModel } from './model-assets.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local embedding model assets', () => {
  it('downloads into the immutable revision directory and reuses verified files', async () => {
    const modelRootDir = await temporaryDirectory();
    const fetchFn = vi.fn(async () => new Response(new TextEncoder().encode('hello')));

    const first = await provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
    });
    const second = await provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await readFile(join(first.modelRoot, 'test', 'tiny-embedding', 'config.json'), 'utf8')).toBe('hello');
    expect(JSON.parse(await readFile(join(first.modelRoot, 'model-manifest.json'), 'utf8')))
      .toMatchObject({ model: testModel.id, revision: testModel.revision });
  });

  it('rejects a hash mismatch and removes temporary files', async () => {
    const modelRootDir = await temporaryDirectory();
    const fetchFn = vi.fn(async () => new Response(new TextEncoder().encode('wrong')));

    await expect(provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
    })).rejects.toThrow('hash mismatch');

    const verification = await verifyLocalEmbeddingModel(testModel.id, modelRootDir);
    expect(verification.available).toBe(false);
    expect(verification.missing).toEqual(['config.json']);
    const repositoryRoot = join(verification.modelRoot, 'test', 'tiny-embedding');
    expect((await readdir(repositoryRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing file that has the right size but the wrong hash', async () => {
    const modelRootDir = await temporaryDirectory();
    const fetchFn = vi.fn(async () => new Response(new TextEncoder().encode('hello')));
    const first = await provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
    });
    const destination = join(first.modelRoot, 'test', 'tiny-embedding', 'config.json');
    await writeFile(destination, 'jello', 'utf8');

    await provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await readFile(destination, 'utf8')).toBe('hello');
  });

  it('honors cancellation before starting a request', async () => {
    const modelRootDir = await temporaryDirectory();
    const fetchFn = vi.fn(async () => new Response(new TextEncoder().encode('hello')));
    const controller = new AbortController();
    controller.abort();

    await expect(provisionLocalEmbeddingModel({
      model: testModel.id,
      modelRootDir,
      fetchFn: fetchFn as typeof fetch,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ls-model-assets-'));
  directories.push(path);
  return path;
}
