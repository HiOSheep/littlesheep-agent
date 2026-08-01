import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareLocalExactContextTokenCounter,
  verifyDeepSeekV4TokenizerAssets,
} from './deepseek-v4-counter.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DeepSeek V4 tokenizer assets', () => {
  it('reports missing and invalid immutable assets separately', async () => {
    const root = await temporaryRoot();
    const missing = await verifyDeepSeekV4TokenizerAssets(root);
    expect(missing.available).toBe(false);
    expect(missing.missing).toEqual(['tokenizer.json', 'tokenizer_config.json']);
    expect(missing.invalid).toEqual([]);

    const repositoryRoot = join(missing.modelRoot, 'deepseek-ai', 'DeepSeek-V4-Flash');
    await mkdir(repositoryRoot, { recursive: true });
    await Promise.all([
      writeFile(join(repositoryRoot, 'tokenizer.json'), '{}', 'utf8'),
      writeFile(join(repositoryRoot, 'tokenizer_config.json'), '{}', 'utf8'),
    ]);

    const invalid = await verifyDeepSeekV4TokenizerAssets(root);
    expect(invalid.available).toBe(false);
    expect(invalid.missing).toEqual([]);
    expect(invalid.invalid).toEqual(['tokenizer.json', 'tokenizer_config.json']);
  });

  it('fails a corrupt download closed, removes temporary files, and permits retry', async () => {
    const root = await temporaryRoot();
    let requestCount = 0;
    const fetchFn = (async () => {
      requestCount++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const options = {
      modelRef: 'deepseek/deepseek-v4-flash',
      modelRootDir: root,
      fetchFn,
      timeoutMs: 1_000,
    };

    await expect(prepareLocalExactContextTokenCounter(options)).rejects.toThrow(/size mismatch/);
    await expect(prepareLocalExactContextTokenCounter(options)).rejects.toThrow(/size mismatch/);
    expect(requestCount).toBe(2);
    expect((await readdir(root, { recursive: true })).some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('does not touch the network for unsupported models', async () => {
    let requested = false;
    const counter = await prepareLocalExactContextTokenCounter({
      modelRef: 'openai/gpt-5.6',
      modelRootDir: await temporaryRoot(),
      fetchFn: (async () => {
        requested = true;
        throw new Error('unexpected request');
      }) as typeof fetch,
    });
    expect(counter).toBeUndefined();
    expect(requested).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-tokenizer-'));
  temporaryRoots.push(root);
  return root;
}
