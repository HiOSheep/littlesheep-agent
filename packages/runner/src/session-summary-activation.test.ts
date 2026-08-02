import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@littlesheep/session';
import type { CompactionSummaryV2 } from '@littlesheep/types';
import { recordSessionSummaryActivation } from './session-summary-activation.js';

const roots: string[] = [];
const NOW = '2026-07-17T09:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recordSessionSummaryActivation', () => {
  it('records only a summary that materially supported a passing run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-runner-summary-activation-'));
    roots.push(root);
    const sessionManager = new SessionManager({ sessionsDir: root });
    const session = await sessionManager.create();
    const summary = makeSummary();
    await sessionManager.commitCompaction(session.id, summary);

    expect(await recordSessionSummaryActivation({
      sessionManager,
      sessionId: session.id,
      summary,
      usedSummaryId: summary.id,
      runId: 'run-pass',
      status: 'ok',
      verification: {
        attempt: 1,
        verdict: 'pass',
        reason: 'Structure passed.',
        source: 'structural',
        verifiedAt: NOW,
      },
      successfulToolCallIds: [],
      recordedAt: NOW,
    })).toBe(true);
    expect(await sessionManager.loadCompactionActivation(session.id, summary.id)).toMatchObject({
      useful: 1,
      verifiedUseful: 1,
    });

    expect(await recordSessionSummaryActivation({
      sessionManager,
      sessionId: session.id,
      summary,
      usedSummaryId: undefined,
      runId: 'run-not-used',
      status: 'ok',
      verification: {
        attempt: 1,
        verdict: 'pass',
        reason: 'No summary needed.',
        source: 'structural',
        verifiedAt: NOW,
      },
      successfulToolCallIds: [],
      recordedAt: NOW,
    })).toBe(false);
    expect((await sessionManager.loadCompactionActivation(session.id, summary.id))?.useful).toBe(1);
  });

  it('keeps model-only success as routing evidence instead of verified evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-runner-summary-routing-'));
    roots.push(root);
    const sessionManager = new SessionManager({ sessionsDir: root });
    const session = await sessionManager.create();
    const summary = makeSummary();
    await sessionManager.commitCompaction(session.id, summary);

    await recordSessionSummaryActivation({
      sessionManager,
      sessionId: session.id,
      summary,
      usedSummaryId: summary.id,
      runId: 'run-model-only',
      status: 'ok',
      verification: {
        attempt: 1,
        verdict: 'pass',
        reason: 'Model reported pass.',
        source: 'model',
        verifiedAt: NOW,
      },
      successfulToolCallIds: [],
      recordedAt: NOW,
    });

    expect(await sessionManager.loadCompactionActivation(session.id, summary.id)).toMatchObject({
      useful: 1,
      verifiedUseful: 0,
    });
  });

  it('records answer-level summary continuity as routing-only evidence without VERIFY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-runner-summary-answer-'));
    roots.push(root);
    const sessionManager = new SessionManager({ sessionsDir: root });
    const session = await sessionManager.create();
    const summary = makeSummary();
    await sessionManager.commitCompaction(session.id, summary);

    expect(await recordSessionSummaryActivation({
      sessionManager,
      sessionId: session.id,
      summary,
      answerUsedSummaryId: summary.id,
      runId: 'run-answer',
      status: 'ok',
      successfulToolCallIds: [],
      recordedAt: NOW,
    })).toBe(true);
    expect(await sessionManager.loadCompactionActivation(session.id, summary.id)).toMatchObject({
      useful: 1,
      verifiedUseful: 0,
    });
  });

  it('does not promote answer-only summary continuity through unrelated tool evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-runner-summary-answer-tool-'));
    roots.push(root);
    const sessionManager = new SessionManager({ sessionsDir: root });
    const session = await sessionManager.create();
    const summary = makeSummary();
    await sessionManager.commitCompaction(session.id, summary);

    await recordSessionSummaryActivation({
      sessionManager,
      sessionId: session.id,
      summary,
      answerUsedSummaryId: summary.id,
      runId: 'run-answer-tool',
      status: 'ok',
      verification: {
        attempt: 1,
        verdict: 'pass',
        reason: 'Unrelated structural work passed.',
        source: 'structural',
        verifiedAt: NOW,
      },
      successfulToolCallIds: ['call-1'],
      recordedAt: NOW,
    });

    expect(await sessionManager.loadCompactionActivation(session.id, summary.id)).toMatchObject({
      useful: 1,
      verifiedUseful: 0,
    });
  });
});

function makeSummary(): CompactionSummaryV2 {
  return {
    version: 2,
    id: 'summary-runner',
    collapsedCount: 2,
    summary: 'Continue the current project task.',
    compactedAt: NOW,
    sourceStartMessageId: 'message-1',
    sourceEndMessageId: 'message-2',
    sourceStartAt: NOW,
    sourceEndAt: NOW,
    cache: {
      version: 1,
      namespace: 'session-summary',
      dataClass: 'semantic',
      compressionDepth: 1,
      disclosureLevel: 'D1',
      vectorClass: 'semantic-cache',
      sourceRefs: ['session:messages:1..2'],
      contentHash: 'a'.repeat(64),
      createdAt: NOW,
    },
    sourceRanges: [{
      messageCount: 2,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-2',
      sourceStartAt: NOW,
      sourceEndAt: NOW,
      sourceHash: 'b'.repeat(64),
    }],
    sourceSummaryIds: [],
    mergedSummaryCount: 1,
    sourceHash: 'b'.repeat(64),
    lineageHash: 'c'.repeat(64),
  };
}
