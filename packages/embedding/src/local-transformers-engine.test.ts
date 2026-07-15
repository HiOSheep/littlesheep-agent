import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTransformersEmbeddingEngine } from './local-transformers-engine.js';
import type { TransformersRuntime } from './runtime.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalTransformersEmbeddingEngine', () => {
  it('keeps product runtime offline and applies query/document prefixes', async () => {
    const modelRootDir = await temporaryDirectory();
    const calls: string[][] = [];
    const runtime = fakeRuntime(calls, 384);
    const engine = new LocalTransformersEmbeddingEngine({
      model: 'multilingual-e5-small',
      modelRootDir,
      runtimeLoader: async () => runtime,
      assetVerifier: async () => true,
    });

    expect(await engine.isAvailable()).toBe(true);
    await engine.embed({ texts: ['寻找记忆'], purpose: 'query' });
    await engine.embed({ texts: ['项目使用 pnpm'], purpose: 'document' });

    expect(runtime.env.allowRemoteModels).toBe(false);
    expect(calls).toEqual([['query: 寻找记忆'], ['passage: 项目使用 pnpm']]);
  });

  it('loads once, batches with a hard limit, and returns normalized dimensions', async () => {
    const modelRootDir = await temporaryDirectory();
    const calls: string[][] = [];
    const runtime = fakeRuntime(calls, 512);
    const engine = new LocalTransformersEmbeddingEngine({
      model: 'bge-small-zh-v1.5',
      modelRootDir,
      batchSize: 2,
      runtimeLoader: async () => runtime,
      assetVerifier: async () => true,
    });
    const result = await engine.embed({ texts: ['a', 'b', 'c'], purpose: 'benchmark' });

    expect(runtime.pipeline).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(result.vectors).toHaveLength(3);
    expect(result.vectors[0]).toHaveLength(512);
  });

  it('fails closed when the local cache is missing and never starts a download', async () => {
    const missing = join(tmpdir(), `ls-embedding-missing-${Date.now()}`);
    const runtimeLoader = vi.fn(async () => fakeRuntime([], 512));
    const engine = new LocalTransformersEmbeddingEngine({
      model: 'bge-small-zh-v1.5',
      modelRootDir: missing,
      runtimeLoader,
    });

    expect(await engine.isAvailable()).toBe(false);
    await expect(engine.embed({ texts: ['x'], purpose: 'query' })).rejects.toThrow(/not provisioned/i);
    expect(runtimeLoader).not.toHaveBeenCalled();
  });

  it('rechecks availability after a model is explicitly provisioned', async () => {
    const modelRootDir = await temporaryDirectory();
    let available = false;
    const assetVerifier = vi.fn(async () => available);
    const engine = new LocalTransformersEmbeddingEngine({
      model: 'bge-small-zh-v1.5',
      modelRootDir,
      runtimeLoader: async () => fakeRuntime([], 512),
      assetVerifier,
    });

    expect(await engine.isAvailable()).toBe(false);
    available = true;
    expect(await engine.isAvailable()).toBe(true);
    expect(assetVerifier).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before model loading', async () => {
    const modelRootDir = await temporaryDirectory();
    const runtimeLoader = vi.fn(async () => fakeRuntime([], 512));
    const engine = new LocalTransformersEmbeddingEngine({
      model: 'bge-small-zh-v1.5',
      modelRootDir,
      runtimeLoader,
      assetVerifier: async () => true,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(engine.embed({ texts: ['x'], purpose: 'query', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(runtimeLoader).not.toHaveBeenCalled();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ls-embedding-'));
  directories.push(path);
  return path;
}

function fakeRuntime(calls: string[][], dimensions: number): TransformersRuntime {
  return {
    env: {},
    pipeline: vi.fn(async () => async (texts: string | string[]) => {
      const list = Array.isArray(texts) ? texts : [texts];
      calls.push(list);
      return {
        tolist: () => list.map(() => Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0)),
      };
    }),
  };
}
