import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from './read.js';
import type { ToolContext } from '@littlesheep/types';

const ctx: ToolContext = { sessionId: 's1' as never, runId: 'r1', cwd: process.cwd() };

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-read-'));
  await writeFile(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  await writeFile(join(tmpDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0xff, 0x42]));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('readTool', () => {
  it('reads a text file fully', async () => {
    const result = await readTool.execute({ file_path: join(tmpDir, 'hello.txt') }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('line1');
    expect(result.output).toContain('line5');
  });

  it('reads with offset (1-based)', async () => {
    const result = await readTool.execute(
      { file_path: join(tmpDir, 'hello.txt'), offset: 3 },
      ctx,
    );
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('line3');
    expect(output).not.toContain('line2');
  });

  it('reads with limit', async () => {
    const result = await readTool.execute(
      { file_path: join(tmpDir, 'hello.txt'), offset: 1, limit: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('line1');
    expect(output).toContain('line2');
    expect(output).not.toContain('line3');
  });

  it('returns hex preview for binary file', async () => {
    const result = await readTool.execute({ file_path: join(tmpDir, 'binary.bin') }, ctx);
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('[binary:');
    expect(output).toContain('hex: 00 01 ff 42');
    expect(result.sanitized).toBe(true);
  });

  it('fails for missing file', async () => {
    const result = await readTool.execute({ file_path: join(tmpDir, 'nope.txt') }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/File not found/);
  });

  it('has correct name and schema', () => {
    expect(readTool.name).toBe('read');
    expect(readTool.requiresApproval).toBeUndefined();
  });
});
