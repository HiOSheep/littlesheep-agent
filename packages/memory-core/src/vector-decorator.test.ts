// @littlesheep/memory-core — vector-decorator.test.ts
// Tests VectorIndexedMemoryStore: only `appendDaily` triggers vector indexing
// (fire-and-forget, failures swallowed). All other methods delegate cleanly.

import { describe, it, expect, vi } from 'vitest';
import { VectorIndexedMemoryStore } from './vector-decorator.js';
import type { MemoryStoreLike } from '@littlesheep/types';
import type { VectorStore, VectorInsert } from '@littlesheep/vector';

// ─── Mocks ──────────────────────────────────────────────────────────────

/** Per-method call log. Each property is a list of arg-arrays. Concrete
 * (non-Record) shape so indexing is never `| undefined` under strict access. */
interface MockCalls {
  appendDaily: unknown[][];
  writeDaily: unknown[][];
  readDaily: unknown[][];
  writeLongTerm: unknown[][];
  appendLongTerm: unknown[][];
  readLongTerm: unknown[][];
  listDailyDates: unknown[][];
  dailyFile: unknown[][];
  today: unknown[][];
}

/** Mock inner MemoryStoreLike that records every call by name. */
function makeMockInner(): MemoryStoreLike & { _calls: MockCalls } {
  const _calls: MockCalls = {
    appendDaily: [],
    writeDaily: [],
    readDaily: [],
    writeLongTerm: [],
    appendLongTerm: [],
    readLongTerm: [],
    listDailyDates: [],
    dailyFile: [],
    today: [],
  };
  const record = (name: keyof MockCalls) => (...args: unknown[]) => {
    _calls[name].push(args);
  };
  return {
    appendDaily: vi.fn(async (date: string, text: string) => { record('appendDaily')(date, text); }),
    writeDaily: vi.fn(async (date: string, content: string) => { record('writeDaily')(date, content); }),
    readDaily: vi.fn(async (date: string) => { record('readDaily')(date); return ''; }),
    writeLongTerm: vi.fn(async (content: string) => { record('writeLongTerm')(content); }),
    appendLongTerm: vi.fn(async (text: string) => { record('appendLongTerm')(text); }),
    readLongTerm: vi.fn(async () => { record('readLongTerm')(); return ''; }),
    listDailyDates: vi.fn(async () => { record('listDailyDates')(); return []; }),
    dailyFile: vi.fn((date: string) => { record('dailyFile')(date); return `/tmp/mock/${date}.md`; }),
    today: vi.fn(() => { record('today')(); return '2026-06-30'; }),
    longTermPath: '/tmp/mock/MEMORY.md',
    dailyDirPath: '/tmp/mock',
    _calls,
  } as unknown as MemoryStoreLike & { _calls: MockCalls };
}

/** Mock VectorStore that records inserts. `insertImpl` lets a test override
 * the insert behaviour (e.g. reject, or return a never-resolving promise). */
function makeMockVectorStore(insertImpl?: (rec: VectorInsert) => Promise<string>) {
  const inserted: VectorInsert[] = [];
  return {
    insert: vi.fn(insertImpl ?? (async (rec: VectorInsert) => {
      inserted.push(rec);
      return 'id';
    })),
    insertBatch: vi.fn(async (recs: VectorInsert[]) => {
      inserted.push(...recs);
      return recs.map(() => 'id');
    }),
    search: vi.fn(async () => []),
    remove: vi.fn(() => 0),
    removeBySource: vi.fn(() => 0),
    removeByTierAndDateRange: vi.fn(() => 0),
    listByTier: vi.fn(() => []),
    count: vi.fn(() => 0),
    countByTier: vi.fn(() => 0),
    close: vi.fn(),
    _inserted: inserted,
  } as unknown as VectorStore & { _inserted: VectorInsert[] };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('VectorIndexedMemoryStore — appendDaily indexing', () => {
  it('appendDaily triggers inner.appendDaily + vectorStore.insert', async () => {
    const inner = makeMockInner();
    const vs = makeMockVectorStore();
    const decorator = new VectorIndexedMemoryStore(inner, vs);

    await decorator.appendDaily('2026-06-30', 'event-driven architecture');
    // Flush the fire-and-forget microtask before asserting insert.
    await new Promise((r) => setTimeout(r, 0));

    // Inner write happened with the exact args.
    expect(inner._calls.appendDaily).toHaveLength(1);
    expect(inner._calls.appendDaily[0]).toEqual(['2026-06-30', 'event-driven architecture']);
    // Vector insert happened once with the right shape.
    expect(vs.insert).toHaveBeenCalledTimes(1);
    expect(vs._inserted).toHaveLength(1);
    expect(vs._inserted[0]).toMatchObject({
      text: 'event-driven architecture',
      tier: 'daily',
      date: '2026-06-30',
      source: '/tmp/mock/2026-06-30.md',
    });
  });

  it('vectorStore.insert rejection does not block appendDaily (fire-and-forget)', async () => {
    const inner = makeMockInner();
    const vs = makeMockVectorStore(async () => {
      throw new Error('embed api down');
    });
    const decorator = new VectorIndexedMemoryStore(inner, vs);

    // Must NOT throw — the write is the source of truth, the vector DB is derived.
    await decorator.appendDaily('2026-06-30', 'text');
    // Flush so the rejected promise's .catch handler runs (swallows the error).
    await new Promise((r) => setTimeout(r, 0));

    // Inner write still succeeded.
    expect(inner._calls.appendDaily).toHaveLength(1);
    // Insert was attempted.
    expect(vs.insert).toHaveBeenCalledTimes(1);
  });

  it('appendDaily insert is not awaited (fire-and-forget timing)', async () => {
    const inner = makeMockInner();
    // Deferred: insert returns a promise we control. If appendDaily awaited it,
    // the await below would hang forever.
    let resolveInsert!: (v: string) => void;
    const pending = new Promise<string>((r) => { resolveInsert = r; });
    const vs = makeMockVectorStore(() => pending);
    const decorator = new VectorIndexedMemoryStore(inner, vs);

    // Should resolve immediately, while the insert promise is still pending.
    await decorator.appendDaily('2026-06-30', 'text');
    // Reaching this line proves appendDaily did NOT await the insert.
    expect(vs.insert).toHaveBeenCalledTimes(1);

    // Cleanup: resolve the dangling promise + flush the .catch microtask.
    resolveInsert('id');
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('VectorIndexedMemoryStore — pure delegation', () => {
  it('other methods delegate to inner without triggering vectorStore.insert', async () => {
    const inner = makeMockInner();
    const vs = makeMockVectorStore();
    const decorator = new VectorIndexedMemoryStore(inner, vs);

    // Async methods.
    await decorator.readLongTerm();
    await decorator.writeLongTerm('lt content');
    await decorator.appendLongTerm('lt append');
    await decorator.readDaily('2026-06-29');
    await decorator.writeDaily('2026-06-29', 'daily content');
    await decorator.listDailyDates();

    // Sync methods + getters.
    expect(decorator.dailyFile('2026-06-30')).toBe('/tmp/mock/2026-06-30.md');
    expect(decorator.today()).toBe('2026-06-30');
    expect(decorator.longTermPath).toBe('/tmp/mock/MEMORY.md');
    expect(decorator.dailyDirPath).toBe('/tmp/mock');

    // Each delegated method was called on inner exactly once.
    expect(inner._calls.readLongTerm).toHaveLength(1);
    expect(inner._calls.writeLongTerm).toHaveLength(1);
    expect(inner._calls.writeLongTerm[0]).toEqual(['lt content']);
    expect(inner._calls.appendLongTerm).toHaveLength(1);
    expect(inner._calls.appendLongTerm[0]).toEqual(['lt append']);
    expect(inner._calls.readDaily).toHaveLength(1);
    expect(inner._calls.readDaily[0]).toEqual(['2026-06-29']);
    expect(inner._calls.writeDaily).toHaveLength(1);
    expect(inner._calls.writeDaily[0]).toEqual(['2026-06-29', 'daily content']);
    expect(inner._calls.listDailyDates).toHaveLength(1);
    expect(inner._calls.dailyFile).toHaveLength(1);
    expect(inner._calls.today).toHaveLength(1);

    // No vector insert happened — delegation is side-effect-free.
    expect(vs.insert).not.toHaveBeenCalled();
  });
});
