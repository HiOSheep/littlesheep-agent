// @littlesheep/memory-core — write-memory.test.ts
// Tests for atomicWrite + the write_memory tool, focused on concurrency.
//
// Scope note — what "atomicity" means here:
//   ✓ FILE-SYSTEM atomicity: the on-disk file is never a byte-level hybrid of
//     two writes. Readers always see either the old file or a complete new
//     file (guaranteed by tmp + rename).
//   ✗ APPLICATION-LEVEL concurrency safety: write_memory does a
//     read-modify-write cycle WITHOUT a file lock. Concurrent appends can lose
//     entries (the last atomicWrite wins). Full safety would need a file lock
//     (flock/lockfile) — tracked as a follow-up.
//
// The concurrency tests below assert the file is always structurally valid
// (no corruption), even when appends race. They do NOT assert every append
// survives — that would require a lock we haven't added yet.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@littlesheep/types';
import { atomicWrite } from './atomic-write.js';
import { createWriteMemoryTool } from './write-memory.js';

// write_memory's execute ignores ctx entirely (it reads deps, not ctx), so a
// minimal placeholder suffices. `as never` sidesteps the SessionId branded type.
const CTX: ToolContext = {
  sessionId: 'test-session' as never,
  runId: 'test-run',
  cwd: '.',
};

// ─── atomicWrite ─────────────────────────────────────────────────────────

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
    // Large uniform payloads: if two writes interleaved at the byte level,
    // the result would contain mixed chars and match none of the payloads.
    const size = 10_000;
    const payloads = ['A', 'B', 'C', 'D', 'E'].map((c) => c.repeat(size));
    await Promise.all(payloads.map((p) => atomicWrite(target, p)));
    const result = await readFile(target, 'utf8');
    // Must be exactly one full payload — not a splice of two.
    expect(payloads).toContain(result);
    expect(result.length).toBe(size);
    // No foreign characters leaked from a sibling write.
    expect(result).toMatch(/^[A-E]+$/);
  });
});

// ─── write_memory tool (functional) ──────────────────────────────────────

describe('write_memory tool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append writes a structured entry to the correct section', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    const res = await tool.execute(
      {
        section: 'Key Decisions',
        title: 'Use SQLite',
        content: 'Picked SQLite for local storage.',
        mode: 'append',
      },
      CTX,
    );
    expect(res.ok).toBe(true);
    const raw = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    expect(raw.startsWith('# Memory')).toBe(true);
    expect(raw).toMatch(/^## Key Decisions$/m);
    expect(raw).toMatch(/- \*\*Use SQLite\*\*/);
    expect(raw).toMatch(/Picked SQLite/);
  });

  it('handles first write (no existing MEMORY.md)', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    const res = await tool.execute(
      { section: 'Long-term Facts', title: 'First', content: 'initial entry', mode: 'append' },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect((res.meta as { replacedExisting: boolean }).replacedExisting).toBe(false);
  });

  it('replace mode overwrites an entry with the same title', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    await tool.execute(
      { section: 'Lessons Learned', title: 'T1', content: 'old content', mode: 'append' },
      CTX,
    );
    const res = await tool.execute(
      { section: 'Lessons Learned', title: 'T1', content: 'new content', mode: 'replace' },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect((res.meta as { replacedExisting: boolean }).replacedExisting).toBe(true);
    const raw = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    expect(raw).not.toMatch(/\bold content\b/);
    expect(raw).toMatch(/new content/);
    // Only one T1 entry — replace didn't leave a duplicate.
    expect((raw.match(/- \*\*T1\*\*/g) ?? []).length).toBe(1);
  });

  it('replace mode appends when the title is not found', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    const res = await tool.execute(
      { section: 'Key Decisions', title: 'Missing', content: 'x', mode: 'replace' },
      CTX,
    );
    expect(res.ok).toBe(true);
    expect((res.meta as { replacedExisting: boolean }).replacedExisting).toBe(false);
  });

  it('rejects empty content (zod min(1))', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    const res = await tool.execute(
      { section: 'Key Decisions', title: 'T', content: '', mode: 'append' },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('rejects content over 2000 chars (zod max)', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    const res = await tool.execute(
      { section: 'Key Decisions', title: 'T', content: 'x'.repeat(2001), mode: 'append' },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('calls onInvalidate after a successful write', async () => {
    let calls = 0;
    const tool = createWriteMemoryTool({ dataDir: dir, onInvalidate: () => { calls++; } });
    await tool.execute(
      { section: 'Key Decisions', title: 'T', content: 'c', mode: 'append' },
      CTX,
    );
    expect(calls).toBe(1);
  });

  it('does not call onInvalidate when validation fails', async () => {
    let calls = 0;
    const tool = createWriteMemoryTool({ dataDir: dir, onInvalidate: () => { calls++; } });
    await tool.execute(
      { section: 'Key Decisions', title: 'T', content: '', mode: 'append' },
      CTX,
    );
    expect(calls).toBe(0);
  });
});

// ─── write_memory concurrency (file-system atomicity) ───────────────────

describe('write_memory concurrency (file-system atomicity)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wmc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent appends leave MEMORY.md structurally valid', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    // 5 concurrent appends to the same section. Due to read-modify-write
    // racing, not all 5 may survive — but the file must remain a valid
    // MEMORY.md (no byte-level corruption, no orphan headers, no partial
    // entries).
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        tool.execute(
          { section: 'Key Decisions', title: `Entry${i}`, content: `content ${i}`, mode: 'append' },
          CTX,
        ),
      ),
    );
    const raw = await readFile(join(dir, 'MEMORY.md'), 'utf8');

    // 1. Header intact (file starts with the canonical title, not garbage).
    expect(raw.startsWith('# Memory')).toBe(true);
    // 2. Section header intact (full line, not half-written).
    expect(raw).toMatch(/^## Key Decisions$/m);
    // 3. At least one well-formed entry survived (the race may drop some,
    //    but never corrupts the survivors).
    const entryTitles = raw.match(/^- \*\*(Entry\d)\*\*$/gm) ?? [];
    expect(entryTitles.length).toBeGreaterThanOrEqual(1);
    // 4. No orphan titles: every `- **title**` line must be followed by an
    //    indented content line (the structure renderMemoryFile emits). A
    //    truncated write would leave a title with no content.
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line && /^- \*\*.+?\*\*$/.test(line)) {
        const next = lines[i + 1] ?? '';
        expect(next.startsWith('  ')).toBe(true);
      }
    }
  });

  it('concurrent replace of the same title yields exactly one coherent entry', async () => {
    const tool = createWriteMemoryTool({ dataDir: dir });
    // Seed the entry.
    await tool.execute(
      { section: 'Key Decisions', title: 'Shared', content: 'initial', mode: 'append' },
      CTX,
    );
    // Concurrently replace with different payloads.
    const candidates = ['v1', 'v2', 'v3'];
    await Promise.all(
      candidates.map((v) =>
        tool.execute(
          { section: 'Key Decisions', title: 'Shared', content: v, mode: 'replace' },
          CTX,
        ),
      ),
    );
    const raw = await readFile(join(dir, 'MEMORY.md'), 'utf8');

    // Exactly one Shared entry (no duplicates from the race).
    const sharedCount = (raw.match(/^- \*\*Shared\*\*$/gm) ?? []).length;
    expect(sharedCount).toBe(1);
    // Its content is one of the candidates verbatim (not a splice of two).
    const contentMatch = raw.match(/^- \*\*Shared\*\*\n  (.+)$/m);
    expect(contentMatch).not.toBeNull();
    expect(candidates).toContain(contentMatch?.[1]);
  });
});
