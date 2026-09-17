import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryConversationSourceConflictError,
  MemoryConversationSourceStore,
} from './conversation-source-store.js';

describe('MemoryConversationSourceStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('persists immutable user-visible records and returns the existing record on idempotent capture', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({
      dataDir,
      now: () => new Date('2026-07-16T06:00:00.000Z'),
    });
    const input = {
      id: 'conversation-source:run-1:user-message:message-1',
      kind: 'user-message' as const,
      sessionId: 'session-1',
      runId: 'run-1',
      occurredAt: '2026-07-16T05:59:00.000Z',
      payload: { text: '请记住这个约束。' },
    };

    const first = await store.capture(input);
    const second = await store.capture(input);

    expect(second).toEqual(first);
    await expect(store.get(input.id)).resolves.toEqual(first);
    await expect(store.getMany([input.id])).resolves.toEqual([first]);
  });

  it('rejects attempts to rewrite an existing source id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    const base = {
      id: 'conversation-source:run-1:assistant-reply',
      kind: 'assistant-reply' as const,
      sessionId: 'session-1',
      runId: 'run-1',
      occurredAt: '2026-07-16T06:00:00.000Z',
      payload: { text: 'first' },
    };
    await store.capture(base);

    await expect(store.capture({ ...base, payload: { text: 'rewritten' } }))
      .rejects.toBeInstanceOf(MemoryConversationSourceConflictError);
  });

  it('produces a stable manifest that changes when a new source is captured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    const before = await store.manifest();
    await store.capture({
      id: 'conversation-source:run-manifest:user-message:message-1',
      kind: 'user-message',
      sessionId: 'session-manifest',
      runId: 'run-manifest',
      occurredAt: '2026-07-16T06:00:00.000Z',
      payload: { text: 'manifest source' },
    });
    const after = await store.manifest();

    expect(before.count).toBe(0);
    expect(after.count).toBe(1);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('requires a bounded session or run scope before listing sources', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });

    await expect(store.catalog({})).rejects.toThrow('requires a sessionId or runId scope');
  });

  it('pages a bounded session directory without returning payload bodies', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    await store.capture(sourceInput({ id: 's1', occurredAt: '2026-07-16T05:00:00.000Z', payload: { text: 'one' } }));
    await store.capture(sourceInput({ id: 's2', occurredAt: '2026-07-16T06:00:00.000Z' }));
    await store.capture(sourceInput({ id: 's3', runId: 'run-2', occurredAt: '2026-07-16T07:00:00.000Z' }));
    await store.capture(sourceInput({ id: 'other', sessionId: 'session-2', occurredAt: '2026-07-16T08:00:00.000Z' }));

    const first = await store.catalog({ sessionId: 'session-1', limit: 2 });
    expect(first.status).toBe('ok');
    expect(first.entries.map((entry) => entry.id)).toEqual(['s1', 's2']);
    expect(first.nextCursor).toBe('s2');
    expect(first.entries[0]).not.toHaveProperty('payload');
    expect(first.entries[0]).toMatchObject({ kind: 'user-message', sessionId: 'session-1', runId: 'run-1' });

    const second = await store.catalog({ sessionId: 'session-1', limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.id)).toEqual(['s3']);
    expect(second.nextCursor).toBeUndefined();

    const byRun = await store.catalog({ runId: 'run-2' });
    expect(byRun.entries.map((entry) => entry.id)).toEqual(['s3']);

    const byKind = await store.catalog({ sessionId: 'session-1', kind: 'assistant-reply' });
    expect(byKind.entries).toEqual([]);
  });

  it('reports unreadable sources as a degraded directory instead of dropping them silently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    await store.capture(sourceInput({ id: 'valid-1' }));
    const corruptDir = join(store.rootDir, 'zz');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'corrupt.conversation-source.json'), '{not json', 'utf8');

    const page = await store.catalog({ sessionId: 'session-1' });
    expect(page.status).toBe('degraded');
    expect(page.reason).toBe('unreadable-sources:1');
    expect(page.entries.map((entry) => entry.id)).toEqual(['valid-1']);
  });

  it('degrades when the directory scan budget is exhausted', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir, catalogScanLimit: 2 });
    await store.capture(sourceInput({ id: 'l1' }));
    await store.capture(sourceInput({ id: 'l2' }));
    await store.capture(sourceInput({ id: 'l3' }));

    const page = await store.catalog({ sessionId: 'session-1' });
    expect(page.status).toBe('degraded');
    expect(page.reason).toBe('catalog-scan-limit-reached');
    expect(page.scanned).toBe(2);
  });

  // HC-13/C08A: repeated captures must not trust a stale in-process entry.
  it('answers repeated captures from memory and still notices an external rewrite', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    const input = sourceInput({ id: 'cached-source' });
    const first = await store.capture(input);

    await expect(store.capture(input)).resolves.toEqual(first);

    // Rewrite the file behind the store's back: the stamp check must force a
    // disk read instead of serving the cached record.
    const digest = createHash('sha256').update(input.id, 'utf8').digest('hex');
    const file = join(dataDir, 'memory-tree', 'v3', 'conversation-sources', digest.slice(0, 2), `${digest}.conversation-source.json`);
    await writeFile(file, '{not-json', 'utf8');
    await expect(store.capture(input)).rejects.toThrow();
  });

  it('stops a cancelled directory scan and reports it as degraded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    await store.capture(sourceInput({ id: 'c1' }));
    await store.capture(sourceInput({ id: 'c2' }));
    const controller = new AbortController();
    controller.abort();

    const page = await store.catalog({ sessionId: 'session-1', signal: controller.signal });
    expect(page.status).toBe('degraded');
    expect(page.reason).toBe('catalog-cancelled');
    expect(page.scanned).toBe(0);
  });

  // HC-02: a first backfill resumes from its watermark instead of re-walking history.
  it('resumes a first backfill from its persisted watermark', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({
      dataDir,
      now: () => new Date('2026-07-16T06:10:00.000Z'),
    });
    const message = (index: number) => sourceInput({
      id: `conversation-source:run-b:user-message:m${index}`,
      sessionId: 'session-b',
      runId: 'run-b',
      occurredAt: `2026-07-16T06:0${index}:00.000Z`,
      payload: { text: `message ${index}` },
    });

    const first = await store.backfill({ sessionId: 'session-b', sources: [message(1), message(2), message(3)] });
    expect(first.captured.map((record) => record.id)).toEqual([message(1).id, message(2).id, message(3).id]);
    expect(first.resumed).toBe(false);
    await expect(store.readBackfillWatermark('session-b')).resolves.toMatchObject({ watermark: message(3).id });

    const replay = await store.backfill({ sessionId: 'session-b', sources: [message(1), message(2), message(3)] });
    expect(replay.captured).toHaveLength(0);
    expect(replay.resumed).toBe(true);
    expect(replay.watermark).toBe(message(3).id);

    const resumed = await store.backfill({
      sessionId: 'session-b',
      sources: [message(1), message(2), message(3), message(4)],
    });
    expect(resumed.captured.map((record) => record.id)).toEqual([message(4).id]);
    await expect(store.readBackfillWatermark('session-b')).resolves.toMatchObject({ watermark: message(4).id });
  });

  it('keeps the watermark after a conflicting backfill so a retry can resume', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-conversation-source-'));
    directories.push(dataDir);
    const store = new MemoryConversationSourceStore({ dataDir });
    const message = (index: number, text = `message ${index}`) => sourceInput({
      id: `conversation-source:run-c:user-message:m${index}`,
      sessionId: 'session-c',
      runId: 'run-c',
      payload: { text },
    });
    await store.backfill({ sessionId: 'session-c', sources: [message(1), message(2)] });
    await store.capture(message(3, 'already captured with different content'));

    await expect(store.backfill({
      sessionId: 'session-c',
      sources: [message(1), message(2), message(3, 'conflicting rewrite')],
    })).rejects.toBeInstanceOf(MemoryConversationSourceConflictError);
    await expect(store.readBackfillWatermark('session-c')).resolves.toMatchObject({ watermark: message(2).id });

    const retry = await store.backfill({
      sessionId: 'session-c',
      sources: [message(1), message(2), message(3, 'already captured with different content'), message(4)],
    });
    // Records after the watermark are re-observed idempotently (existing content returns the stored record).
    expect(retry.captured.map((record) => record.id)).toEqual([message(3).id, message(4).id]);
    await expect(store.readBackfillWatermark('session-c')).resolves.toMatchObject({ watermark: message(4).id });
  });
});

function sourceInput(overrides: {
  id: string;
  kind?: 'user-message' | 'assistant-reply';
  sessionId?: string;
  runId?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}) {
  return {
    kind: overrides.kind ?? ('user-message' as const),
    sessionId: overrides.sessionId ?? 'session-1',
    runId: overrides.runId ?? 'run-1',
    occurredAt: overrides.occurredAt ?? '2026-07-16T06:00:00.000Z',
    payload: overrides.payload ?? { text: 'source' },
    ...overrides,
  };
}
