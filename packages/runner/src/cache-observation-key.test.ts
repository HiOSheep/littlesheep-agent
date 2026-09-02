import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCacheObservationKey } from './cache-observation-key.js';

describe('loadCacheObservationKey', () => {
  it('creates one data-root-local key and reuses it across loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-cache-observation-key-'));
    const first = await loadCacheObservationKey(root);
    const second = await loadCacheObservationKey(root);

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    await expect(readFile(join(root, 'config', 'cache-observation.key'), 'utf8'))
      .resolves.toBe(`${first}\n`);
  });

  it('does not accept a corrupt persisted key as an HMAC identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-cache-observation-key-'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'cache-observation.key'), 'not-a-key\n', 'utf8');

    const replacement = await loadCacheObservationKey(root);
    expect(replacement).toBeNull();
  });
});
