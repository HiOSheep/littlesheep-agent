// @littlesheep/tools — memory_deep_search.test.ts
// Tests the read-only deep search tool: cross-tier keyword search, date
// filtering, missing archive dir, no matches, and the structural read-only
// guarantee (no vectorStore injection point).
//
// Plain-text queries are used so ripgrep (case-sensitive) and the naive
// fallback (case-insensitive substring) behave identically — the tests are
// robust to whether `rg` is installed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDeepSearchTool } from './memory_deep_search.js';
import type { ToolContext } from '@littlesheep/types';

const ctx: ToolContext = { sessionId: 's1' as never, runId: 'r1', cwd: process.cwd() };

let tmpDir: string;
let archiveDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-deep-'));
  archiveDir = join(tmpDir, 'archive');
  // Build the archive tree:
  //   archive/2025/03/15.md       (daily)
  //   archive/2025/03/summary.md  (monthly-summary)
  //   archive/2025/summary.md     (yearly-summary)
  //   archive/2026/01/10.md       (daily)
  await mkdir(join(archiveDir, '2025', '03'), { recursive: true });
  await mkdir(join(archiveDir, '2026', '01'), { recursive: true });
  await writeFile(
    join(archiveDir, '2025', '03', '15.md'),
    'discussed event-driven architecture\n',
    'utf8',
  );
  await writeFile(
    join(archiveDir, '2025', '03', 'summary.md'),
    'March summary: focused on architecture\n',
    'utf8',
  );
  await writeFile(
    join(archiveDir, '2025', 'summary.md'),
    '2025 yearly: architecture decisions\n',
    'utf8',
  );
  await writeFile(
    join(archiveDir, '2026', '01', '10.md'),
    'learned about sqlite vector search\n',
    'utf8',
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('memory_deep_search tool', () => {
  it('search finds matches across tiers', async () => {
    const tool = createMemoryDeepSearchTool(archiveDir);
    const result = await tool.execute({ query: 'architecture' }, ctx);

    expect(result.ok).toBe(true);
    const output = result.output as string;
    // 3 files contain "architecture": daily, monthly-summary, yearly-summary.
    expect(result.meta?.hits).toBeGreaterThanOrEqual(2);
    expect(output).toContain('[daily]');
    expect(output).toContain('[yearly-summary]');
  });

  it('since/until filter by date', async () => {
    const tool = createMemoryDeepSearchTool(archiveDir);
    const result = await tool.execute(
      { query: 'architecture', since: '2025-03-01', until: '2025-03-31' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const output = result.output as string;
    // Only the 2025-03-15 daily hit falls in [2025-03-01, 2025-03-31].
    // The monthly-summary date '2025-03' < '2025-03-01' (lexicographic) and the
    // yearly date '2025' < '2025-03-01' — both filtered out.
    expect(result.meta?.hits).toBeGreaterThanOrEqual(1);
    expect(output).toContain('2025-03-15');
    expect(output).toContain('[daily]');
    expect(output).not.toContain('[yearly-summary]');
  });

  it('no archive dir → "No archive directory exists yet"', async () => {
    const tool = createMemoryDeepSearchTool(join(tmpDir, 'does-not-exist'));
    const result = await tool.execute({ query: 'anything' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('No archive directory');
    expect(result.meta?.hits).toBe(0);
  });

  it('no matches → "No archived memory matches found"', async () => {
    const tool = createMemoryDeepSearchTool(archiveDir);
    const result = await tool.execute({ query: 'nonexistent_xyz' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('No archived memory matches found');
    expect(result.meta?.hits).toBe(0);
  });

  it('read-only: tool has no vectorStore injection point', async () => {
    // Structural guarantee: the constructor takes only archiveDir (1 param).
    expect(createMemoryDeepSearchTool.length).toBe(1);

    const tool = createMemoryDeepSearchTool(archiveDir);
    // The returned tool object exposes no vectorStore / insert / index handle.
    const keys = Object.keys(tool);
    expect(keys).not.toContain('vectorStore');
    expect(keys).not.toContain('insert');
    expect(keys).not.toContain('index');

    // Functional guarantee: execute works without any vector DB and returns ok.
    const result = await tool.execute({ query: 'architecture' }, ctx);
    expect(result.ok).toBe(true);
  });
});
