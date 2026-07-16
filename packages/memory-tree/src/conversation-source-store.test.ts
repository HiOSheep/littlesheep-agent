import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
});
