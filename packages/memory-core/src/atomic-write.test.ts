// @littlesheep/memory-core — atomic-write.test.ts
// Tests for the shared filesystem-atomic write primitive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.js';

describe('atomicWrite', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write + read roundtrip preserves content exactly (unicode + emoji)', async () => {
    const target = join(dir, 'roundtrip.txt');
    const payload = 'line1\nline2\n中文测试 emoji 🎉\ntrailing\n';
    await atomicWrite(target, payload);
    const read = await readFile(target, 'utf8');
    expect(read).toBe(payload);
  });

  it('concurrent writes never produce a corrupted hybrid', async () => {
    const target = join(dir, 'concurrent.txt');
    // Large uniform payloads: byte-level interleaving would match none of them.
    const size = 10_000;
    const payloads = ['A', 'B', 'C', 'D', 'E'].map((character) => character.repeat(size));
    await Promise.all(payloads.map((payload) => atomicWrite(target, payload)));
    const result = await readFile(target, 'utf8');
    expect(payloads).toContain(result);
    expect(result).toHaveLength(size);
    expect(result).toMatch(/^[A-E]+$/);
  });
});
