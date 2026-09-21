import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textMessage, type CompactionSummaryV2, type Message } from '@littlesheep/types';
import { SessionManager, StaleCompactionError } from './manager.js';
import { hashCompactionMessages, maybeCompact } from './compaction.js';

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
  return { manager, sessionId: session.id, messages, dir };
}

describe('maybeCompact', () => {
  it('does not let concurrent writers overwrite a summary prepared from the same predecessor', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const summarize = async (label: string) => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return { summary: label };
    };

    const settled = await Promise.allSettled([
      maybeCompact(manager, sessionId, {
        threshold: 1,
        keepRecent: 2,
        summarize: () => summarize('writer-a'),
      }),
      maybeCompact(manager, sessionId, {
        threshold: 1,
        keepRecent: 2,
        summarize: () => summarize('writer-b'),
      }),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = (await manager.loadMetadata(sessionId))?.compaction;
    expect(active?.summary === 'writer-a' || active?.summary === 'writer-b').toBe(true);
    expect(await manager.read(sessionId)).toHaveLength(7);
  });

  it('rejects a stale writer that prepared before another manager replaced the summary', async () => {
    const { dir, sessionId } = await managerWithMessages(7);
    const first = new SessionManager({ sessionsDir: dir });
    const second = new SessionManager({ sessionsDir: dir });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const stale = maybeCompact(first, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => {
        entered();
        await barrier;
        return { summary: 'stale-writer' };
      },
    });
    await started;

    const fresh = await maybeCompact(second, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({ summary: 'fresh-writer' }),
    });
    expect(fresh?.summary).toBe('fresh-writer');
    release();

    await expect(stale).rejects.toThrow(/projection conflict|stale/iu);
    expect((await second.loadMetadata(sessionId))?.compaction?.summary).toBe('fresh-writer');
    expect(await second.read(sessionId)).toHaveLength(7);
  });

  it('keeps messages appended while a snapshot is summarized outside the covered prefix', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const compacting = maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => {
        entered();
        await barrier;
        return { summary: 'stable prefix' };
      },
    });
    await started;
    await manager.append(sessionId, [textMessage('user', 'new suffix', { id: 'suffix-after-snapshot' })]);
    release();

    const summary = await compacting;
    expect(summary?.sourceEndMessageId).toBe('message-5');
    expect((await manager.read(sessionId)).at(-1)?.id).toBe('suffix-after-snapshot');
    expect((await manager.loadMetadata(sessionId))?.compaction?.id).toBe(summary?.id);
  });

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

  // SP-07: the summary and the range it covers become visible in one switch.
  it('switches the active summary and its covered range together', async () => {
    const { manager, sessionId, messages } = await managerWithMessages(7);
    const result = await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize: async () => ({ summary: 'atomic switch' }),
    });
    expect(result).toBeTruthy();
    if (!result || result.version !== 2) throw new Error('Expected a v2 compaction summary.');

    // One record carries both halves: which messages the switch covers and the
    // summary installed by it. A reader can never observe the new summary with
    // the old coverage (or the reverse).
    const active = (await manager.loadMetadata(sessionId))?.compaction as CompactionSummaryV2 | undefined;
    const projection = await manager.loadCompactionProjection(sessionId, result.id) as CompactionSummaryV2;
    const covered = messages.slice(0, 5);
    for (const record of [active, projection, result]) {
      expect(record).toMatchObject({
        id: result.id,
        collapsedCount: 5,
        sourceStartMessageId: 'message-1',
        sourceEndMessageId: 'message-5',
      });
      expect(record?.sourceHash).toBe(hashCompactionMessages(covered));
    }
    expect((await manager.loadMetadata(sessionId))?.compacted).toBe(true);

    // Compaction never truncates the transcript it summarized.
    expect((await manager.read(sessionId)).map((message) => message.id))
      .toEqual(messages.map((message) => message.id));
  });

  // SP-07: a failed switch keeps the previous valid summary and its range.
  it('keeps the previous valid summary when a later compaction fails', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const first = await maybeCompact(manager, sessionId, {
      threshold: 6,
      keepRecent: 2,
      summarize: async () => ({ summary: 'first valid summary' }),
    });
    expect(first).toBeTruthy();
    const firstState = (await manager.loadMetadata(sessionId))?.compaction;

    await manager.append(sessionId, [
      textMessage('user', 'message-8', { id: 'message-8', runId: 'run-4' }),
      textMessage('assistant', 'message-9', { id: 'message-9', runId: 'run-4' }),
      textMessage('user', 'message-10', { id: 'message-10', runId: 'run-5' }),
    ]);
    await expect(maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => {
        throw new Error('summarizer unavailable');
      },
    })).rejects.toThrow('summarizer unavailable');

    // The failed attempt leaves no partial switch behind.
    const afterFailure = (await manager.loadMetadata(sessionId))?.compaction;
    expect(afterFailure?.id).toBe(firstState?.id);
    expect(afterFailure?.sourceEndMessageId).toBe('message-5');
    expect(afterFailure?.collapsedCount).toBe(5);
    expect(await manager.listPendingCompactions(sessionId)).toEqual([]);

    // The range the failed attempt was asked to cover is still uncovered, so the
    // next successful switch extends the same valid summary instead of skipping it.
    const second = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({ summary: 'second valid summary' }),
    });
    expect(second?.version === 2 && second.previousSummaryId).toBe(firstState?.id);
    expect(second?.collapsedCount).toBeGreaterThan(5);
    expect((await manager.read(sessionId))).toHaveLength(10);
  });

  it('persists memory candidates in the same compaction transaction before projection settlement', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const result = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({
        summary: 'summary with candidate',
        memoryEvidenceComplete: true,
        memoryCandidates: [{
          id: 'candidate-1',
          branch: 'long-term',
          parentNodeId: 'long-term:root',
          scope: 'global',
          summary: 'User preference',
          content: 'The user prefers concise responses.',
          retrievalKeys: ['preference', 'concise'],
          sourceMessageIds: ['message-1'],
          importance: 0.8,
          confidence: 0.9,
          reason: 'Explicit preference in the covered source.',
        }],
      }),
    });

    expect(await manager.listPendingCompactions(sessionId)).toMatchObject([{
      summary: { id: result?.id },
      memoryProposal: {
        evidenceComplete: true,
        candidates: [{ id: 'candidate-1', sourceMessageIds: ['message-1'] }],
        outcomes: [],
      },
    }]);
  });

  // C10A: a failed model call before persistence leaves no summary and no durable proposal.
  it('leaves no durable proposal when the model call fails before persistence', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    await expect(maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => {
        throw new Error('compaction model unavailable');
      },
    })).rejects.toThrow('compaction model unavailable');

    expect((await manager.loadMetadata(sessionId))?.compaction).toBeUndefined();
    expect(await manager.listPendingCompactions(sessionId)).toEqual([]);
    expect(await manager.read(sessionId)).toHaveLength(7);
  });

  // HC-05: an empty candidate list is a legal complete proposal and needs no further model work.
  it('accepts an empty candidate list as a complete compaction proposal', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const result = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({
        summary: 'summary without durable candidates',
        memoryEvidenceComplete: true,
        memoryCandidates: [],
      }),
    });
    expect(result).toBeTruthy();

    expect(await manager.listPendingCompactions(sessionId)).toMatchObject([{
      summary: { id: result?.id },
      memoryProposal: { candidates: [], outcomes: [] },
    }]);
    await manager.completeCompactionMemoryProposal(sessionId, result!.id);
    expect(await manager.listPendingCompactions(sessionId)).toEqual([]);
    expect((await manager.loadMetadata(sessionId))?.compaction?.id).toBe(result!.id);
  });

  // C10A: the pending proposal survives a process restart and each candidate outcome stays single-write.
  it('recovers a committed proposal after a manager restart and settles each candidate once', async () => {
    const { manager, sessionId, dir } = await managerWithMessages(7);
    const first = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({
        summary: 'summary with two candidates',
        memoryEvidenceComplete: true,
        memoryCandidates: [candidate('candidate-a'), candidate('candidate-b')],
      }),
    });
    expect(first).toBeTruthy();

    const reopened = new SessionManager({ sessionsDir: dir });
    expect(await reopened.listPendingCompactions(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: first!.id },
      summaryCommittedAt: expect.any(String),
      memoryProposal: { candidates: [{ id: 'candidate-a' }, { id: 'candidate-b' }], outcomes: [] },
    }]);

    await reopened.recordCompactionCandidateOutcome(sessionId, first!.id, candidateOutcome('candidate-a'));
    await reopened.recordCompactionCandidateOutcome(sessionId, first!.id, candidateOutcome('candidate-a'));

    // Simulate another crash between partial candidate commits.
    const afterCrash = new SessionManager({ sessionsDir: dir });
    const partial = (await afterCrash.listPendingCompactions(sessionId))[0];
    expect(partial?.version).toBe(2);
    expect(partial?.version === 2 ? partial.memoryProposal?.outcomes : []).toHaveLength(1);

    await afterCrash.recordCompactionCandidateOutcome(sessionId, first!.id, candidateOutcome('candidate-b'));
    await afterCrash.completeCompactionMemoryProposal(sessionId, first!.id);

    expect(await afterCrash.listPendingCompactions(sessionId)).toEqual([]);
    expect((await afterCrash.loadMetadata(sessionId))?.compaction?.id).toBe(first!.id);
    await expect(afterCrash.loadCompactionProjection(sessionId, first!.id)).resolves.toBeTruthy();
  });

  // C10A: an old compactor losing the predecessor race must not replace the active summary.
  it('rejects a stale predecessor without replacing the active summary', async () => {
    const { manager, sessionId } = await managerWithMessages(7);
    const first = await maybeCompact(manager, sessionId, {
      threshold: 1,
      keepRecent: 2,
      summarize: async () => ({ summary: 'active summary' }),
    });
    expect(first).toBeTruthy();
    if (!first || first.version !== 2) throw new Error('Expected a v2 compaction summary.');

    const stale = { ...first, id: 'summary-stale-late', summary: 'stale summary from an old writer' };
    await expect(manager.commitCompaction(sessionId, stale, {
      expectedPreviousSummaryId: null,
      sourceEndMessageId: first.sourceEndMessageId,
      sourceHash: first.sourceHash,
      policyVersion: 3,
      transactionKey: 'stale-late-key',
    })).rejects.toThrow(StaleCompactionError);

    expect((await manager.loadMetadata(sessionId))?.compaction?.id).toBe(first.id);
    expect(await manager.listPendingCompactions(sessionId)).toEqual([]);
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

function candidate(id: string) {
  return {
    id,
    branch: 'long-term' as const,
    parentNodeId: 'long-term:root',
    scope: 'global' as const,
    summary: `Candidate ${id}`,
    content: `Durable candidate ${id}.`,
    retrievalKeys: [id, 'durable'],
    sourceMessageIds: ['message-1'],
    importance: 0.8,
    confidence: 0.9,
    reason: 'Synthetic durable candidate for the restart contract.',
  };
}

function candidateOutcome(candidateId: string) {
  return {
    candidateId,
    status: 'committed' as const,
    nodeId: `node-${candidateId}`,
    reason: 'created',
    updatedAt: new Date().toISOString(),
  };
}
