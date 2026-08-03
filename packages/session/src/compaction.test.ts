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
    {
      id: `message-${index + 1}`,
      runId: `run-${Math.floor(index / 2) + 1}`,
      timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    },
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
    expect(summarize.mock.calls[0]?.[0].coveredMessages.map((message: Message) => message.id)).toEqual(
      messages.slice(0, 5).map((message: Message) => message.id),
    );
    expect(result).toMatchObject({
      version: 2,
      collapsedCount: 5,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-5',
      sourceRunIds: ['run-1', 'run-2', 'run-3'],
      sourceRunIdsTruncated: false,
      model: 'openai/gpt-test',
      cache: {
        namespace: 'session-summary',
        compressionDepth: 1,
        disclosureLevel: 'D1',
        vectorClass: 'semantic-cache',
      },
    });
    expect(await manager.read(sessionId)).toHaveLength(7);
    expect(result && await manager.loadCompactionProjection(sessionId, result.id)).toEqual(result);
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
    expect(summarize.mock.calls[0]?.[0].coveredMessages.map((message: Message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
      'message-5',
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

  it('flattens the fourth compression into level three and preserves the source transcript', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const before = JSON.stringify(await manager.read(sessionId));
    const summaries = [];
    for (let round = 0; round < 4; round += 1) {
      if (round > 0) {
        await manager.append(sessionId, Array.from({ length: 4 }, (_, index) => textMessage(
          index % 2 === 0 ? 'user' : 'assistant',
          `round-${round}-${index}`,
          { id: `round-${round}-${index}` },
        )));
      }
      const summary = await maybeCompact(manager, sessionId, {
        threshold: 6,
        keepRecent: 2,
        summarize: async ({ previousSummary, messages }) => ({
          summary: `${previousSummary?.summary ?? 'root'}|${messages.map((message) => message.id).join(',')}`,
        }),
      });
      expect(summary?.version).toBe(2);
      summaries.push(summary!);
    }

    expect(summaries.map((summary) => summary.version === 2 ? summary.cache.compressionDepth : 0))
      .toEqual([1, 2, 3, 3]);
    const latest = summaries.at(-1)!;
    expect(latest.version).toBe(2);
    if (latest.version !== 2) throw new Error('Expected a v2 compaction summary.');
    expect(latest.previousSummaryId).toBeUndefined();
    expect(latest.sourceSummaryIds.length).toBeLessThanOrEqual(3);
    expect(latest.sourceRanges).toHaveLength(1);
    expect(latest.sourceRanges[0]?.messageCount).toBe(latest.collapsedCount);
    expect(latest.mergedSummaryCount).toBe(4);
    expect(await manager.loadCompactionProjection(sessionId, latest.id)).toEqual(latest);

    const after = await manager.read(sessionId);
    expect(JSON.stringify(after.slice(0, 7))).toBe(before);
    expect(after).toHaveLength(19);
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

  it('bounds source run provenance while retaining the most recent covered runs', async () => {
    const { manager, sessionId } = await managerWithMessages(70);
    const result = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 1,
      force: true,
      summarize: async () => ({ summary: 'bounded source runs' }),
    });

    expect(result?.version).toBe(2);
    if (!result || result.version !== 2) throw new Error('Expected a v2 compaction summary.');
    expect(result.sourceRunIds).toHaveLength(35);
    expect(result.sourceRunIds?.at(0)).toBe('run-1');
    expect(result.sourceRunIds?.at(-1)).toBe('run-35');
    expect(result.sourceRunIdsTruncated).toBe(false);

    const additional = Array.from({ length: 140 }, (_, index) => textMessage('user', `extra-${index}`, {
      id: `extra-${index}`,
      runId: `extra-run-${index}`,
    }));
    await manager.append(sessionId, additional);
    const extended = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 1,
      force: true,
      summarize: async () => ({ summary: 'truncated source runs' }),
    });
    if (!extended || extended.version !== 2) throw new Error('Expected an extended v2 compaction summary.');
    expect(extended.sourceRunIds).toHaveLength(64);
    expect(extended.sourceRunIds?.at(-1)).toBe('extra-run-138');
    expect(extended.sourceRunIdsTruncated).toBe(true);
  });
});
