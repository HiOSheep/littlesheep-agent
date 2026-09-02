import { describe, expect, it } from 'vitest';
import type { FetchedDocument } from '@littlesheep/types';
import { MemoryWebCache } from './web-cache.js';

function document(url: string, content: string): FetchedDocument {
  return {
    version: 1,
    requestedUrl: url,
    finalUrl: url,
    redirectChain: [],
    status: 200,
    contentType: 'text/plain',
    extractor: 'plain_text',
    content,
    contentHash: `sha256:${content.length}`,
    fetchedAt: '2026-08-29T00:00:00.000Z',
    cached: false,
    truncated: false,
    externalUntrusted: true,
    warnings: [],
  };
}

describe('MemoryWebCache bounds', () => {
  it('expires entries by TTL and can be cleared', async () => {
    let now = 1_000;
    const cache = new MemoryWebCache(10_000, 100, () => now);
    await cache.set('hash:a', document('https://example.com/a', 'text'));
    await expect(cache.get('hash:a')).resolves.toMatchObject({ content: 'text' });
    now += 101;
    await expect(cache.get('hash:a')).resolves.toBeUndefined();
    await cache.set('hash:b', document('https://example.com/b', 'text'));
    await cache.clear();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('evicts least-recently-used entries to remain under the byte cap', async () => {
    let now = 1_000;
    const sample = document('https://example.com/a', 'a'.repeat(2_000));
    const oneEntryBytes = Buffer.byteLength(JSON.stringify(sample), 'utf8');
    const cache = new MemoryWebCache(oneEntryBytes + 100, 1_000, () => now);
    await cache.set('hash:a', sample);
    now += 1;
    await cache.set('hash:b', document('https://example.com/b', 'b'.repeat(2_000)));
    expect(cache.stats().entries).toBe(1);
    await expect(cache.get('hash:a')).resolves.toBeUndefined();
    await expect(cache.get('hash:b')).resolves.toBeDefined();
  });

  it('returns a clone so callers cannot mutate cached state', async () => {
    const cache = new MemoryWebCache(10_000, 1_000);
    await cache.set('hash:a', document('https://example.com/a', 'original'));
    const first = await cache.get('hash:a');
    (first as { content: string }).content = 'mutated';
    await expect(cache.get('hash:a')).resolves.toMatchObject({ content: 'original' });
  });

  it('refuses an entry larger than the configured capacity', async () => {
    const cache = new MemoryWebCache(100, 1_000);
    await cache.set('hash:a', document('https://example.com/a', 'too large'));
    expect(cache.stats().entries).toBe(0);
  });
});
