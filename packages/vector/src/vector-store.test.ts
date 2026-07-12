// @littlesheep/vector — vector-store.test.ts
// Exercises the SQLite-backed VectorStore with a mock LlmClient whose embed
// returns deterministic, character-hash vectors. Tests insert/search/filter/
// remove mechanics — not real semantic similarity (that needs an embedding API).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from './vector-store.js';
import type { LlmClient, ChatResponse, EmbedRequest, EmbedResponse } from '@littlesheep/llm';

/** Build a mock LlmClient whose embed returns deterministic char-hash vectors. */
function makeMockLlm(dimensions: number): LlmClient {
  const chat = vi.fn(async (): Promise<ChatResponse> => ({
    content: '',
    toolCalls: [],
    finishReason: 'stop',
  }));
  const chatStream = vi.fn();
  const embed = vi.fn(async (req: EmbedRequest): Promise<EmbedResponse> => {
    const dims = req.dimensions ?? dimensions;
    const input = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings = input.map((text) => {
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dims] += text.charCodeAt(i) / 1000;
      }
      return vec;
    });
    return { embeddings, model: req.model, usage: { promptTokens: 0 } };
  });
  return { chat, chatStream, embed } as unknown as LlmClient;
}

const DIMS = 8;
let dbDir: string;
let store: VectorStore;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'ls-vec-'));
  store = new VectorStore({
    dbPath: join(dbDir, 'test.db'),
    embeddingModel: 'test-model',
    dimensions: DIMS,
    llm: makeMockLlm(DIMS),
  });
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('VectorStore — insert + search', () => {
  it('insert then search returns the record with score > 0', async () => {
    await store.insert({
      text: 'hello world',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/hello.md',
    });
    const results = await store.search('hello world', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('hello world');
    expect(results[0]!.tier).toBe('daily');
    expect(results[0]!.date).toBe('2026-06-30');
    expect(results[0]!.source).toBe('/tmp/hello.md');
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('search respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await store.insert({
        text: `item ${i}`,
        tier: 'daily',
        date: '2026-06-30',
        source: `/tmp/${i}.md`,
      });
    }
    const results = await store.search('item', 3);
    expect(results).toHaveLength(3);
  });
});

describe('VectorStore — search filters', () => {
  it('filter by tier restricts results', async () => {
    await store.insert({
      text: 'daily entry',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/d.md',
    });
    await store.insert({
      text: 'monthly summary',
      tier: 'monthly-summary',
      date: '2026-06',
      source: '/tmp/m.md',
    });
    const dailyOnly = await store.search('entry', 10, { tiers: ['daily'] });
    expect(dailyOnly).toHaveLength(1);
    expect(dailyOnly[0]!.tier).toBe('daily');

    const monthlyOnly = await store.search('summary', 10, { tiers: ['monthly-summary'] });
    expect(monthlyOnly).toHaveLength(1);
    expect(monthlyOnly[0]!.tier).toBe('monthly-summary');
  });

  it('filter by date range (since/until)', async () => {
    await store.insert({
      text: 'old entry',
      tier: 'daily',
      date: '2026-01-15',
      source: '/tmp/old.md',
    });
    await store.insert({
      text: 'new entry',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/new.md',
    });
    const filtered = await store.search('entry', 10, {
      since: '2026-06-01',
      until: '2026-06-30',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.date).toBe('2026-06-30');
  });
});

describe('VectorStore — remove operations', () => {
  it('removeBySource deletes matching records and returns count', async () => {
    await store.insert({
      text: 'a',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/a.md',
    });
    await store.insert({
      text: 'b',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/b.md',
    });
    const removed = store.removeBySource('/tmp/a.md');
    expect(removed).toBe(1);
    expect(store.count()).toBe(1);
  });

  it('removeByTierAndDateRange deletes records in range', async () => {
    await store.insert({
      text: 'old',
      tier: 'daily',
      date: '2026-01-01',
      source: '/tmp/old.md',
    });
    await store.insert({
      text: 'new',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/new.md',
    });
    const removed = store.removeByTierAndDateRange('daily', undefined, '2026-05-31');
    expect(removed).toBe(1);
    expect(store.count()).toBe(1);
    const remaining = await store.search('new', 10);
    expect(remaining[0]!.date).toBe('2026-06-30');
  });
});

describe('VectorStore — count + listByTier', () => {
  it('count and countByTier reflect inserts', async () => {
    await store.insert({
      text: 'a',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/a.md',
    });
    await store.insert({
      text: 'b',
      tier: 'monthly-summary',
      date: '2026-06',
      source: '/tmp/b.md',
    });
    expect(store.count()).toBe(2);
    expect(store.countByTier('daily')).toBe(1);
    expect(store.countByTier('monthly-summary')).toBe(1);
  });

  it('listByTier returns records ordered by date DESC', async () => {
    await store.insert({
      text: 'first',
      tier: 'daily',
      date: '2026-06-28',
      source: '/tmp/1.md',
    });
    await store.insert({
      text: 'second',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/2.md',
    });
    const list = store.listByTier('daily');
    expect(list).toHaveLength(2);
    // Ordered by date DESC — newest first.
    expect(list[0]!.date).toBe('2026-06-30');
    expect(list[1]!.date).toBe('2026-06-28');
    // listByTier does not return embeddings — text + metadata only.
    expect(list[0]!.text).toBe('second');
  });
});
