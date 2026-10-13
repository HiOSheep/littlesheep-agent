import { describe, expect, it } from 'vitest';
import { ContextEngine } from '@littlesheep/context';
import { asSessionId } from '@littlesheep/types';
import { ContextInspectionStore, projectContextInspection } from './context-inspection.js';

function evidence(sessionId = 'session-a', runId = 'run-a') {
  const prepared = new ContextEngine().prepare({ runId, sessionId: asSessionId(sessionId), stage: 'execute', requestIndex: 1,
    request: { model: 'test/model', messages: [{ role: 'user', content: 'SECRET_BODY' }] } });
  return { runId, sessionId, modelRequests: [prepared.modelRequestSnapshot], contextSnapshots: [prepared.contextSnapshot] };
}

describe('content-free Context Inspection ownership and retention', () => {
  it('never accesses raw log, prompt, user or tool output fields', () => {
    const safe = evidence();
    const raw = Object.defineProperties(safe, Object.fromEntries(['systemPromptProjection', 'inboundText', 'reply', 'toolCalls', 'memoryAccess'].map((key) =>
      [key, { get() { throw new Error(`raw field accessed: ${key}`); } }])));
    const store = new ContextInspectionStore();
    store.observe(raw);
    const output = store.inspect('session-a');
    expect(output.requests).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain('SECRET_BODY');
    expect(JSON.stringify(output)).not.toContain('contentHash');
    expect(JSON.stringify(output)).not.toContain('systemPromptProjection');
  });
  it('keeps session isolation, active state, unknown ledgers and mutable callers separate', () => {
    const store = new ContextInspectionStore();
    store.observe(evidence());
    const live = evidence('session-b', 'run-b');
    expect(store.inspect('session-a', [live]).active).toBe(false);
    const inspection = store.inspect('session-b', [live]);
    expect(inspection.active).toBe(true);
    expect(inspection.requests[0]!.trace.tokens.provider.status).toBe('unavailable');
    expect(inspection.requests[0]!.maxContextTokens).toBeUndefined();
    inspection.requests[0]!.trace.sources.length = 0;
    expect(store.inspect('session-a').requests[0]!.trace.sources.length).toBeGreaterThan(0);
    expect(store.inspect('unowned').requests).toEqual([]);
  });
  it('rejects mismatched evidence and reports bounded history rather than all-time totals', () => {
    const first = evidence();
    first.modelRequests[0] = { ...first.modelRequests[0]!, sessionId: asSessionId('other') };
    expect(projectContextInspection(first)).toEqual([]);
    const store = new ContextInspectionStore();
    for (let i = 0; i < 40; i++) store.observe(evidence('session-a', `run-${i}`));
    const inspection = store.inspect('session-a');
    expect(inspection.requests).toHaveLength(32);
    expect(inspection.retainedRequests).toBe(40);
    expect(inspection.truncated).toBe(true);
    expect(inspection.coverage).toBe('loaded_history');
  });
});
