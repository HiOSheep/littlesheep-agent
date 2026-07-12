import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTool } from './write.js';
import type { ToolContext } from '@littlesheep/types';

const approvedCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  approve: async () => true,
};

const deniedCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  approve: async () => false,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-write-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('writeTool', () => {
  it('writes content to a new file', async () => {
    const file = join(tmpDir, 'new.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'hello content' },
      approvedCtx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('hello content');
  });

  it('overwrites existing file', async () => {
    const file = join(tmpDir, 'overwrite.txt');
    await writeTool.execute({ file_path: file, content: 'v1' }, approvedCtx);
    await writeTool.execute({ file_path: file, content: 'v2' }, approvedCtx);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('v2');
  });

  it('creates nested directories', async () => {
    const file = join(tmpDir, 'a', 'b', 'c', 'deep.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'deep' },
      approvedCtx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('deep');
  });

  it('fails when approval is denied', async () => {
    const file = join(tmpDir, 'denied.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'no' },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
    await expect(stat(file)).rejects.toThrow();
  });

  it('requires approval', () => {
    expect(writeTool.requiresApproval).toBe(true);
  });
});
