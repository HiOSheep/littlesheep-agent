import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textMessage, type Message } from '@littlesheep/types';
import { SessionManager } from './manager.js';
import { maybeCompact } from './compaction.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function managerWithMessages(count: number) {
  const dir = await mkdtemp(join(tmpdir(), 'littlesheep-compaction-'));
  tempDirs.push(dir);
  const manager = new SessionManager({ sessionsDir: dir });
  const session = await manager.create('openai/gpt-test');
  const messages = Array.from({ length: count }, (_, index) => textMessage(
    index % 2 === 0 ? 'user' : 'assistant',
    `message-${index + 1}`,
    { id: `message-${index + 1}`, timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString() },
  ));
  await manager.append(session.id, messages);
  return { manager, sessionId: session.id, messages };
}

describe('maybeCompact', () => {
  it('writes a versioned summary without deleting original messages', async () => {
    const { manager, sessionId, messages } = await managerWithMessages(7);
    const summarize = vi.fn(async ({ messages: selected }) => ({
      summary: `summary:${selected.map((message: Message) => message.id).join(',')}`,
      model: 'openai/gpt-test',
    }));

    const result = await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0].messages.map((message: Message) => message.id)).toEqual(
      messages.slice(0, 5).map((message: Message) => message.id),
    );
    expect(result).toMatchObject({
      version: 1,
      collapsedCount: 5,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-5',
      model: 'openai/gpt-test',
    });
    expect(await manager.read(sessionId)).toHaveLength(7);
    expect(await manager.loadMetadata(sessionId)).toMatchObject({
      compacted: true,
      compaction: { id: result?.id, sourceEndMessageId: 'message-5' },
    });
  });

  it('extends the previous summary only after another full threshold of messages', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const first = await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize: async () => ({ summary: 'first summary', model: 'model-1' }),
    });
    await manager.append(sessionId, Array.from({ length: 4 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `new-${index + 1}`,
      { id: `new-${index + 1}` },
    )));
    const summarize = vi.fn(async ({ previousSummary, messages }) => ({
      summary: `${previousSummary?.summary};${messages.map((message: Message) => message.id).join(',')}`,
      model: 'model-2',
    }));

    const second = await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize,
    });

    expect(summarize.mock.calls[0]?.[0].previousSummary?.id).toBe(first?.id);
    expect(summarize.mock.calls[0]?.[0].messages.map((message: Message) => message.id)).toEqual([
      'message-6',
      'message-7',
      'new-1',
      'new-2',
    ]);
    expect(second).toMatchObject({
      collapsedCount: 9,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'new-2',
      previousSummaryId: first?.id,
    });
    expect(await manager.read(sessionId)).toHaveLength(11);
  });

  it('does nothing below the threshold', async () => {
    const { manager, sessionId } = await managerWithMessages(5);
    const summarize = vi.fn();
    expect(await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize,
    })).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('can compact early when an exact Context ledger crosses the configured ratio', async () => {
    const { manager, sessionId } = await managerWithMessages(5);
    const summarize = vi.fn(async () => ({ summary: 'forced summary' }));
    const result = await maybeCompact(manager, sessionId, {
      threshold: 100,
      keepRecent: 2,
      force: true,
      summarize,
    });

    expect(result).toMatchObject({ collapsedCount: 3, summary: 'forced summary' });
    expect(summarize).toHaveBeenCalledOnce();
  });
});
