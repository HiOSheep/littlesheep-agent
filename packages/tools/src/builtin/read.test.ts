import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from './read.js';
import type { ToolContext } from '@littlesheep/types';
import { createInMemoryFileObservationPort, hashFileBytes } from '../file-observation.js';

const ctx: ToolContext = { sessionId: 's1' as never, runId: 'r1', cwd: process.cwd() };

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-read-'));
  await writeFile(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  await writeFile(join(tmpDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0xff, 0x42]));
  // Larger than DEFAULT_SANITIZE.maxOutputChars, so a full read gets truncated.
  await writeFile(join(tmpDir, 'big.txt'), `${'x'.repeat(12_000)}\n`, 'utf8');
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

// RS-01: a read is the only thing that may testify about a file version.
describe('readTool observation registration', () => {
  function ctxWithPort(): { ctx: ToolContext; port: ReturnType<typeof createInMemoryFileObservationPort> } {
    const port = createInMemoryFileObservationPort();
    return { ctx: { ...ctx, observation: port }, port };
  }

  it('registers the delivered version of a full read', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'hello.txt');

    const result = await readTool.execute({ file_path: file }, context);

    expect(result.ok).toBe(true);
    const lookup = port.lookup(file);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.snapshot.coverage).toBe('full');
      expect(lookup.snapshot.version).toBe(hashFileBytes('line1\nline2\nline3\nline4\nline5\n'));
      expect(lookup.snapshot.sizeBytes).toBe(30);
      expect(lookup.snapshot.runId).toBe('r1');
    }
  });

  it('records the visible line range for a windowed read', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'hello.txt');

    await readTool.execute({ file_path: file, offset: 3, limit: 2 }, context);

    const lookup = port.lookup(file);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.snapshot.coverage).toBe('partial');
      expect(lookup.snapshot.visibleLineRange).toEqual({ start: 3, end: 4 });
    }
  });

  it('does not treat a truncated delivery as having read the file', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'big.txt');

    const result = await readTool.execute({ file_path: file }, context);

    expect(result.ok).toBe(true);
    expect(result.sanitized).toBe(true);
    expect(port.lookup(file).ok).toBe(false);
  });

  it('does not register a binary preview', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'binary.bin');

    await readTool.execute({ file_path: file }, context);

    expect(port.lookup(file).ok).toBe(false);
  });

  it('does not register a failed read', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'nope.txt');

    const result = await readTool.execute({ file_path: file }, context);

    expect(result.ok).toBe(false);
    expect(port.lookup(file).ok).toBe(false);
  });

  it('registers nothing while an opaque mutation is in flight', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'hello.txt');
    const release = port.suspend();

    await readTool.execute({ file_path: file }, context);
    const during = port.lookup(file);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.errorKind).toBe('observation_suspended');

    release();
    // Nothing was recorded, so the model has to read again after the command.
    expect(port.lookup(file).ok).toBe(false);
  });

  it('replaces the observation when the file is read again after a change', async () => {
    const { ctx: context, port } = ctxWithPort();
    const file = join(tmpDir, 'hello.txt');
    await readTool.execute({ file_path: file }, context);
    await writeFile(file, 'changed\n', 'utf8');

    await readTool.execute({ file_path: file }, context);

    const lookup = port.lookup(file);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.snapshot.version).toBe(hashFileBytes('changed\n'));
  });
});
