import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globTool, globToRegex } from './glob.js';
import type { ToolContext } from '@littlesheep/types';

const ctx: ToolContext = { sessionId: 's1' as never, runId: 'r1', cwd: process.cwd() };

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-glob-'));
  await writeFile(join(tmpDir, 'a.ts'), 'x', 'utf8');
  await writeFile(join(tmpDir, 'b.ts'), 'x', 'utf8');
  await writeFile(join(tmpDir, 'c.md'), 'x', 'utf8');
  await mkdir(join(tmpDir, 'sub'));
  await writeFile(join(tmpDir, 'sub', 'd.ts'), 'x', 'utf8');
  await writeFile(join(tmpDir, 'sub', 'e.md'), 'x', 'utf8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('globToRegex', () => {
  it('matches exact name', () => {
    const re = globToRegex('a.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('b.ts')).toBe(false);
  });

  it('matches single * wildcard', () => {
    const re = globToRegex('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('b.ts')).toBe(true);
    expect(re.test('c.md')).toBe(false);
  });

  it('matches ** recursive', () => {
    const re = globToRegex('**/*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('sub/d.ts')).toBe(true);
    expect(re.test('sub/e.md')).toBe(false);
  });

  it('matches ? single char', () => {
    const re = globToRegex('?.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('ab.ts')).toBe(false);
  });
});

describe('globTool', () => {
  it('finds .ts files at root with *.ts', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: tmpDir }, ctx);
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('a.ts');
    expect(output).toContain('b.ts');
    expect(output).not.toContain('c.md');
  });

  it('finds recursively with **/*.ts', async () => {
    const result = await globTool.execute({ pattern: '**/*.ts', path: tmpDir }, ctx);
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('a.ts');
    // Cross-platform: sub\d.ts (Windows) or sub/d.ts (Unix)
    expect(output.toLowerCase()).toMatch(/sub[\\/]d\.ts/);
    expect(output).not.toContain('c.md');
    expect(output).not.toContain('e.md');
  });

  it('respects max_results', async () => {
    const result = await globTool.execute(
      { pattern: '**/*', path: tmpDir, max_results: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    const lines = (result.output as string).split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(2);
    const meta = result.meta as { count: number };
    expect(meta.count).toBeLessThanOrEqual(2);
  });

  it('returns "No files matched" for no hits', async () => {
    const result = await globTool.execute({ pattern: '*.xyz', path: tmpDir }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No files matched');
  });

  it('fails for missing path', async () => {
    const result = await globTool.execute(
      { pattern: '*', path: join(tmpDir, 'nope') },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Path not found/);
  });
});
