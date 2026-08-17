import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectStorageFiles,
  quarantineStorageFile,
  readBoundedJsonFile,
} from './storage-file-io.js';

describe('Memory v3 storage file I/O', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ls-memory-storage-files-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discovers matching files recursively in stable path order and enforces the file budget', async () => {
    await Promise.all([
      mkdir(join(root, 'b'), { recursive: true }),
      mkdir(join(root, 'a'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'b', '2.record.json'), '{}', 'utf8'),
      writeFile(join(root, 'a', '1.record.json'), '{}', 'utf8'),
      writeFile(join(root, 'a', 'ignored.txt'), 'ignored', 'utf8'),
    ]);

    const files = await collectStorageFiles({
      root,
      suffix: '.record.json',
      maximumFiles: 2,
      limitMessage: (limit) => `record limit ${limit}`,
    });
    expect(files).toEqual([
      join(root, 'a', '1.record.json'),
      join(root, 'b', '2.record.json'),
    ]);
    await expect(collectStorageFiles({
      root,
      suffix: '.record.json',
      maximumFiles: 1,
      limitMessage: (limit) => `record limit ${limit}`,
    })).rejects.toThrow('record limit 1');
  });

  it('honors cancellation before traversing a scan', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop scan'));
    await expect(collectStorageFiles({
      root,
      suffix: '.json',
      maximumFiles: 1,
      limitMessage: () => 'limit',
      signal: controller.signal,
    })).rejects.toThrow('stop scan');
  });

  it('rejects an oversized JSON file through the domain byte assertion', async () => {
    const path = join(root, 'oversized.json');
    await writeFile(path, JSON.stringify({ body: 'x'.repeat(128) }), 'utf8');
    await expect(readBoundedJsonFile(path, 32, (actual, maximum) => {
      if (actual > maximum) throw new Error(`too large: ${actual} > ${maximum}`);
    })).rejects.toThrow(/too large:/u);
    await expect(readBoundedJsonFile(path, 32, () => undefined))
      .rejects.toThrow(/storage file exceeds the 32 byte safety limit/iu);
  });

  it('moves an invalid file and writes the supplied reason metadata', async () => {
    const source = join(root, 'broken.record.json');
    const destinationDir = join(root, 'quarantine');
    await writeFile(source, '{broken', 'utf8');
    let tick = Date.parse('2026-08-17T00:00:00.000Z');
    const destination = await quarantineStorageFile({
      source,
      destinationDir,
      details: { version: 99, reason: 'invalid json', category: 'corrupt' },
      now: () => new Date(tick += 1_000),
    });

    await expect(access(source)).rejects.toThrow();
    expect(await readFile(destination, 'utf8')).toBe('{broken');
    expect(JSON.parse(await readFile(`${destination}.reason.json`, 'utf8'))).toMatchObject({
      version: 1,
      reason: 'invalid json',
      category: 'corrupt',
      quarantinedAt: '2026-08-17T00:00:02.000Z',
    });
  });
});
