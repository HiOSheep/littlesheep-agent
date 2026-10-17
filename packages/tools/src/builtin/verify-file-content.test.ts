import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@littlesheep/types';
import { createExplicitFileContentCheckTool, runtimeFileContentCheckPath } from './verify-file-content.js';

let workspace = '';
const context = (): ToolContext => ({ sessionId: 's1' as never, runId: 'r1', cwd: workspace });

beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'ls-task-outcome-check-')); });
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

describe('Runtime explicit file content checker', () => {
  it('reads the actual file and records failed without returning its contents', async () => {
    const file = join(workspace, 'result.txt');
    await writeFile(file, 'goodbye', 'utf8');
    const tool = createExplicitFileContentCheckTool({
      runId: 'r1', requirementId: 'req-1', filePath: 'result.txt', expectedContent: 'hello',
    });

    const result = await tool.execute({}, context());

    expect(result.ok).toBe(true);
    expect(result.output).toContain('does not match');
    expect(result.output).not.toContain('goodbye');
    expect(result.meta?.taskOutcomeCheck).toMatchObject({
      requirementId: 'req-1', status: 'failed', resourceRef: 'workspace:result.txt',
    });
    expect(JSON.stringify(result.meta)).not.toContain('goodbye');
    expect(await readFile(file, 'utf8')).toBe('goodbye');
  });

  it('passes only when the current bytes exactly match and emits a content digest', async () => {
    await writeFile(join(workspace, 'result.txt'), 'hello', 'utf8');
    const tool = createExplicitFileContentCheckTool({
      runId: 'r1', requirementId: 'req-2', filePath: 'result.txt', expectedContent: 'hello',
    });

    const result = await tool.execute({}, context());
    const receipt = result.meta?.taskOutcomeCheck as Record<string, unknown>;
    expect(receipt).toMatchObject({ requirementId: 'req-2', status: 'passed' });
    expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.evidenceId).toBeTruthy();
  });

  it('blocks unsupported paths and refuses model-supplied checking inputs', async () => {
    expect(() => createExplicitFileContentCheckTool({
      runId: 'r1', requirementId: 'req-3', filePath: '../outside.txt', expectedContent: 'hello',
    })).toThrow(/root-level workspace filename/u);
    const tool = createExplicitFileContentCheckTool({
      runId: 'r1', requirementId: 'req-4', filePath: 'result.txt', expectedContent: 'hello',
    });
    const result = await tool.execute({ file_path: '../outside.txt', expected: 'attacker value' }, context());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not accept model-supplied');
  });

  it('reports a missing required file as failed without inventing a file hash', async () => {
    const tool = createExplicitFileContentCheckTool({
      runId: 'r1', requirementId: 'req-missing', filePath: 'missing.txt', expectedContent: 'hello',
    });
    const result = await tool.execute({}, context());
    const receipt = result.meta?.taskOutcomeCheck as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(receipt).toMatchObject({ status: 'failed', reasonCode: 'file_missing' });
    expect(receipt.contentHash).toBeUndefined();
  });

  it('checks only one listed file at a time for a bounded multi-requirement request', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello', 'utf8');
    await writeFile(join(workspace, 'b.txt'), 'goodbye', 'utf8');
    const tool = createExplicitFileContentCheckTool([
      { runId: 'r1', requirementId: 'req-a', filePath: 'a.txt', expectedContent: 'hello' },
      { runId: 'r1', requirementId: 'req-b', filePath: 'b.txt', expectedContent: 'world' },
    ]);

    expect(runtimeFileContentCheckPath(tool, { file_path: 'a.txt' })).toBe('a.txt');
    expect(runtimeFileContentCheckPath(tool, { file_path: '../private.txt' })).toBeUndefined();
    const passed = await tool.execute({ file_path: 'a.txt' }, context());
    const failed = await tool.execute({ file_path: 'b.txt' }, context());
    expect(passed.meta?.taskOutcomeCheck).toMatchObject({ requirementId: 'req-a', status: 'passed' });
    expect(failed.meta?.taskOutcomeCheck).toMatchObject({ requirementId: 'req-b', status: 'failed' });
    expect(JSON.stringify([passed.meta, failed.meta])).not.toContain('goodbye');
    const rejected = await tool.execute({ file_path: '../private.txt' }, context());
    expect(rejected.ok).toBe(false);
  });
});
