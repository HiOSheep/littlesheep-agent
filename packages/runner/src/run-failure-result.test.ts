import { describe, expect, it } from 'vitest';
import { clearUnpublishedNextResult, runtimeFailureResult } from './run-failure-result.js';
import type { RunnerResult } from './runner.js';

function failedResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'error',
    reply: '',
    error: 'user-facing reply generation failed: Authentication Fails, Your api key: ****f138 is invalid',
    messages: [{
      id: 'proposal',
      role: 'assistant',
      stage: 'finalize',
      content: [{ type: 'text', text: 'unsettled model proposal' }],
      timestamp: new Date(0).toISOString(),
    }],
    trace: [],
    durationMs: 1,
    ...overrides,
  } as RunnerResult;
}

describe('next-path runtime failure publication', () => {
  it('keeps the actionable Runtime failure detail and never the model proposal', () => {
    const published = runtimeFailureResult(failedResult(), 'run_failed_before_publication');
    expect(published.status).toBe('error');
    expect(published.reply).toBe('');
    expect(published.runtimeStatus).toMatchObject({ status: 'failed', reason: 'run_failed_before_publication' });
    expect(published.error).toContain('Authentication Fails');
    expect(published.error).not.toContain('unsettled model proposal');
    expect(published.messages).toEqual([]);
  });

  it('falls back to the bounded Runtime sentence when no detail exists', () => {
    const published = runtimeFailureResult(failedResult({ error: undefined }), 'finalize_persistence_failed');
    expect(published.error).toBe('Runtime failed before publishing a final reply. Reason: finalize_persistence_failed');
  });

  it('bounds a very long failure detail', () => {
    const published = runtimeFailureResult(failedResult({ error: 'x'.repeat(4_000) }), 'run_failed_before_publication');
    expect(published.error?.length).toBe(512);
  });

  it('clears every unpublished artifact', () => {
    const cleared = clearUnpublishedNextResult(failedResult({
      reply: 'provisional',
      finalReplySettlement: { version: 1, status: 'proposed' } as never,
    }));
    expect(cleared.reply).toBe('');
    expect(cleared.finalReplySettlement).toBeUndefined();
    expect(cleared.messages).toEqual([]);
  });
});