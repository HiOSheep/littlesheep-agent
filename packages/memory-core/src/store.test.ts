import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, buildRecentPrelude, searchMemory } from './index.js';
import { formatDate } from './store.js';

let tmpDir: string;
let store: MemoryStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-mem-'));
  store = new MemoryStore({ rootDir: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('MemoryStore', () => {
  it('writes and reads long-term memory', async () => {
    await store.writeLongTerm('# Memory\n\n- item 1');
    const content = await store.readLongTerm();
    expect(content).toContain('item 1');
  });

  it('appends to long-term memory', async () => {
    await store.writeLongTerm('base');
    await store.appendLongTerm('appended');
    const content = await store.readLongTerm();
    expect(content).toContain('base');
    expect(content).toContain('appended');
  });

  it('writes and reads daily memory', async () => {
    const today = store.today();
    await store.appendDaily(today, 'learned something new');
    const content = await store.readDaily(today);
    expect(content).toContain('learned something new');
    expect(content).toContain(`# Memory — ${today}`);
  });

  it('lists daily dates', async () => {
    await store.appendDaily('2026-06-28', 'day 1');
    await store.appendDaily('2026-06-29', 'day 2');
    const dates = await store.listDailyDates();
    expect(dates).toEqual(['2026-06-28', '2026-06-29']);
  });
});

describe('buildRecentPrelude', () => {
  it('returns empty prelude when no daily memory', async () => {
    const prelude = await buildRecentPrelude(store, { days: 3 });
    expect(prelude.content).toBe('');
    expect(prelude.daysIncluded).toBe(0);
  });

  it('includes recent days', async () => {
    const today = formatDate(new Date());
    await store.appendDaily(today, 'today insight');
    const prelude = await buildRecentPrelude(store, { days: 3 });
    expect(prelude.daysIncluded).toBe(1);
    expect(prelude.content).toContain('today insight');
    expect(prelude.content).toContain(today);
  });

  it('respects total max chars', async () => {
    const today = formatDate(new Date());
    const longText = 'x'.repeat(5000);
    await store.appendDaily(today, longText);
    const prelude = await buildRecentPrelude(store, { days: 1, totalMaxChars: 100 });
    expect(prelude.chars).toBeLessThanOrEqual(200);
    expect(prelude.truncated).toBe(true);
  });
});

describe('searchMemory', () => {
  it('finds matches in long-term and daily memory', async () => {
    await store.writeLongTerm('# Memory\n\n- important fact about cats');
    await store.appendDaily('2026-06-29', 'discussed cats today');
    const hits = await searchMemory(store, { query: 'cats', limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const allSnippets = hits.map((h) => h.snippet).join(' ');
    expect(allSnippets.toLowerCase()).toContain('cats');
  });

  it('returns empty when no matches', async () => {
    await store.writeLongTerm('nothing relevant here');
    const hits = await searchMemory(store, { query: 'xyznonexistent', limit: 10 });
    expect(hits).toHaveLength(0);
  });
});
