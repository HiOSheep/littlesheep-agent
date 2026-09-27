// @littlesheep/harness — stages/verify.test.ts
// Unit tests for the VERIFY stage after the forced verification model call was
// deleted: narrow structural passes, explicit `unverified` records for
// completed runs, and bounded recovery from recorded failures. No path may
// spend a model request.
import { describe, it, expect } from 'vitest';
import { createVerifyStage } from './verify.js';
import { makeCtx } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';
import type { RunContext, ToolResult } from '@littlesheep/types';

const stage = createVerifyStage();

function llmProvenance(ctx: RunContext, purpose: 'execute_tool_loop' | 'execute_final_reply' = 'execute_tool_loop') {
  return {
    version: 1 as const,
    source: 'llm' as const,
    purpose,
    modelRequestId: 'model-request-1',
    modelRequestIndex: 1,
    provider: 'deepseek',
    model: 'deepseek-flash',
    generatedAt: '2026-09-12T00:00:00.000Z',
    rewriteCount: 0,
  };
}

function makeVerifyCtx(opts: {
  reply?: string;
  toolResults?: ToolResult[];
} = {}) {
  const ctx = makeCtx({ inbound: textMessage('user', 'read the file and summarize') });
  ctx.reply = opts.reply ?? 'done';
  ctx.replyProvenance = llmProvenance(ctx);
  ctx.toolResults = opts.toolResults ?? [];
  ctx.plan = [{ description: 'read file' }];
  return ctx;
}

describe('verifyStage', () => {
  it('records an unverified verdict instead of a structural pass for a mixed write and read run', async () => {
    const ctx = makeVerifyCtx({ reply: '游戏文件已经创建并核验。' });
    ctx.streamModelTranscript = true;
    ctx.taskBook = undefined;
    ctx.replyProvenance = llmProvenance(ctx);
    ctx.toolInvocations = ['write', 'grep'].map((toolName, index) => ({
      version: 1 as const,
      id: `invocation-${index}`,
      callId: `call-${index}`,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName,
      toolSource: 'builtin' as const,
      status: 'succeeded' as const,
      proposedAt: `2026-09-12T00:00:0${index}.000Z`,
      endedAt: `2026-09-12T00:00:0${index + 1}.000Z`,
      approval: { required: false, decision: 'not_required' as const },
      evidenceIds: [],
    }));
    ctx.sideEffects = [{
      idempotencyKey: 'write-effect', toolName: 'write', status: 'succeeded', callId: 'call-0',
    }];
    ctx.toolResults = [
      { callId: 'call-0', ok: true, output: 'written' },
      { callId: 'call-1', ok: true, output: 'match' },
    ];

    const res = await stage(ctx);

    // The code can prove the calls succeeded; it cannot prove that an unrelated
    // read satisfies the user's acceptance, so the run is not called verified.
    expect(res).toMatchObject({ next: 'finalize', ok: true, meta: { verdict: 'unverified' } });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.reason).toContain('not verified');
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('lets unresolved Runtime effects override completion and retracts the draft', async () => {
    const ctx = makeVerifyCtx({ reply: 'The file was created successfully.' });
    const replacements: string[] = [];
    ctx.onAssistantReplace = (value) => replacements.push(value);
    ctx.toolInvocations = [{
      version: 1,
      id: 'write-invocation',
      callId: 'write-call',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'write',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];
    ctx.toolResults = [{ callId: 'write-call', ok: true, output: 'written' }];
    ctx.sideEffects = [{
      idempotencyKey: 'write-effect',
      toolName: 'write',
      status: 'unknown',
      callId: 'write-call',
    }];

    await expect(stage(ctx)).resolves.toMatchObject({
      next: 'recover',
      ok: false,
      meta: { runtimeEvidenceGap: expect.stringContaining('side effect') },
    });
    expect(ctx.reply).toBeUndefined();
    expect(ctx.replyProvenance).toBeUndefined();
    expect(replacements.at(-1)).toBe('');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
  });

  it('completes a run with complete evidence as unverified and never calls a model', async () => {
    const ctx = makeVerifyCtx();

    const res = await stage(ctx);

    expect(res.next).toBe('finalize');
    expect(res.ok).toBe(true);
    expect(res.meta?.verdict).toBe('unverified');
    expect(res.meta?.runtimeEvidenceComplete).toBe(true);
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  // The two narrow structural fast paths (`pass` for one successful read-only
  // call, `pass` for an exact write-then-read) are proven from real harness runs
  // in `verify/structural-evidence.test.ts`: hand-building a TaskBook and a
  // TaskExecution here could only ever exercise the retired plan shapes, which is
  // exactly the unreachability HC-03 removed.

  it('records a completed task book run as unverified without a model verdict', async () => {
    const ctx = makeVerifyCtx();
    ctx.taskBook = {
      assessment: {
        userNeed: 'review core',
        complexity: 'standard',
        goal: 'find core gaps',
        successCriteria: ['gaps are named'],
        requiresTaskBook: true,
        maxExtraScopeRatio: 1.5,
      },
      goal: 'find core gaps',
      complexity: 'standard',
      successCriteria: ['gaps are named'],
      steps: [{ id: 'step-1', description: 'inspect state machine', acceptanceCriteria: ['state machine inspected'] }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
    };
    ctx.taskExecution = {
      goal: 'find core gaps',
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-07-09T00:00:00.000Z',
      endedAt: '2026-07-09T00:00:01.000Z',
      summary: 'core gaps were named',
      steps: [{
        stepId: 'step-1',
        description: 'inspect state machine',
        status: 'done',
        startedAt: '2026-07-09T00:00:00.000Z',
        endedAt: '2026-07-09T00:00:01.000Z',
        acceptanceCriteria: ['state machine inspected'],
        output: 'state machine inspected',
        toolCallIds: [],
        toolResults: [],
      }],
    };

    const res = await stage(ctx);

    expect(res.next).toBe('finalize');
    expect(res.meta?.verdict).toBe('unverified');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.usedMemoryAtomIds).toBeUndefined();
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  // Step-scoped partial re-planning was deleted with the second execution
  // system (HC-03): `deriveReplanTargets` / `canRecoverWithPartialReplan` /
  // `installPartialReplan` no longer exist, and a structural gap now always
  // records `fail` and routes to RECOVER. The cases that pinned the re-plan
  // machinery are gone with it; `evidence-gap.test.ts` covers the routing.

  it('publishes the answer as unverified when the run recorded a tool failure', async () => {
    const ctx = makeVerifyCtx({
      toolResults: [{ callId: 'c1', ok: false, error: 'file not found' }],
    });
    ctx.toolInvocations = [{
      version: 1,
      id: 'invocation-c1',
      callId: 'c1',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'read',
      toolSource: 'builtin',
      status: 'failed',
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }];

    const res = await stage(ctx);

    // A recorded failure is a known outcome, not missing evidence: the answer is
    // published, but the verdict can never become `pass`.
    expect(res.next).toBe('finalize');
    expect(res.ok).toBe(true);
    expect(res.meta).toMatchObject({
      verdict: 'unverified',
      recordedFailures: ['tool invocation c1 is failed'],
    });
    expect(ctx.lastError).toBeUndefined();
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(ctx.verificationHistory?.at(-1)?.reason).toContain('c1 is failed');
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('still routes an unusable invocation to recover instead of publishing', async () => {
    const ctx = makeVerifyCtx();
    ctx.toolInvocations = [{
      version: 1,
      id: 'invocation-c2',
      callId: 'c2',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: 'write',
      toolSource: 'builtin',
      status: 'approval_denied',
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: true, decision: 'denied' },
      evidenceIds: [],
    }];

    const res = await stage(ctx);

    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(ctx.lastError?.message).toContain('c2 is approval_denied');
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
  });

  it('rejects a missing Provider-authored reply as an incomplete execution', async () => {
    const ctx = makeVerifyCtx();
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;

    const res = await stage(ctx);

    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'fail', source: 'structural' });
    expect(ctx.modelRequests ?? []).toHaveLength(0);
  });

  it('never spends a model request on any verification path', async () => {
    const complete = makeVerifyCtx();
    await stage(complete);

    // A real structural gap (one call id recorded twice) takes the `fail` →
    // recover path; it must not buy a model verdict either.
    const incomplete = makeVerifyCtx();
    incomplete.toolInvocations = ['invocation-1', 'invocation-2'].map((id) => ({
      version: 1 as const,
      id,
      callId: 'c1',
      runId: incomplete.runId,
      sessionId: incomplete.sessionId,
      toolName: 'read',
      toolSource: 'builtin' as const,
      status: 'succeeded' as const,
      proposedAt: '2026-09-12T00:00:00.000Z',
      endedAt: '2026-09-12T00:00:01.000Z',
      approval: { required: false, decision: 'not_required' as const },
      evidenceIds: [],
    }));
    await stage(incomplete);

    expect(complete.modelRequests ?? []).toHaveLength(0);
    expect(incomplete.modelRequests ?? []).toHaveLength(0);
    expect(incomplete.lastError?.message).toContain('duplicate tool invocation c1');
  });
});
