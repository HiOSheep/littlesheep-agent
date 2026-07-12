import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from './grep.js';
import type { ToolContext } from '@littlesheep/types';

const ctx: ToolContext = { sessionId: 's1' as never, runId: 'r1', cwd: process.cwd() };

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-grep-'));
  await writeFile(
    join(tmpDir, 'a.ts'),
    'function hello() {\n  return "world";\n}\n',
    'utf8',
  );
  await writeFile(
    join(tmpDir, 'b.ts'),
    'const TARGET = 42;\nexport { TARGET };\n',
    'utf8',
  );
  await writeFile(join(tmpDir, 'notes.md'), '# Notes\nhello there\n', 'utf8');
  await mkdir(join(tmpDir, 'sub'));
  await writeFile(join(tmpDir, 'sub', 'c.ts'), 'export const TARGET = "sub";\n', 'utf8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('grepTool', () => {
  it('finds pattern across files (naive or ripgrep)', async () => {
    const result = await grepTool.execute(
      { pattern: 'TARGET', path: tmpDir },
      ctx,
    );
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('b.ts');
    expect(output).toContain('c.ts');
  });

  it('finds pattern in single file', async () => {
    const result = await grepTool.execute(
      { pattern: 'hello', path: join(tmpDir, 'a.ts') },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('function hello');
  });

  it('respects glob filter', async () => {
    const result = await grepTool.execute(
      { pattern: 'TARGET', path: tmpDir, glob: '*.ts' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('b.ts');
    expect(output).not.toContain('notes.md');
  });

  it('respects max_results', async () => {
    const result = await grepTool.execute(
      { pattern: 'TARGET', path: tmpDir, max_results: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    // output should have at most 1 line (plus possible stderr separator)
    const lines = (result.output as string)
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('[stderr]'));
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it('returns "No matches" when pattern not found', async () => {
    const result = await grepTool.execute(
      { pattern: 'NOTHING_HERE_xyz', path: tmpDir },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No matches');
  });

  it('fails for missing path', async () => {
    const result = await grepTool.execute(
      { pattern: 'x', path: join(tmpDir, 'nope') },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Path not found/);
  });
});
