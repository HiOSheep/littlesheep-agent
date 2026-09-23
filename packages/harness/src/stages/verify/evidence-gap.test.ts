// CE-07: what "the tool result is missing" actually means.
//
// The recorded report had a run whose VERIFY declared the tool evidence
// incomplete. Nothing in the repository's history for that run is available, so
// this file does the part that can be established from source: it drives
// `runtimeExecutionEvidenceGap` through every boundary the taskbook lists and
// records which fact produces which verdict. Two of them are wrong on the
// pre-fix code — a resumed run's own inherited ledger, and a recorded *failed*
// outcome in a legacy checkpoint — and those are the two the fix changes.
import { describe, expect, it } from 'vitest';
import type {
  RunContext,
  SideEffectCheckpoint,
  TaskStepResult,
  ToolInvocationRecord,
  ToolResult,
} from '@littlesheep/types';
import { textMessage } from '@littlesheep/types';
import { makeCtx } from '../../tests/helpers.js';
import { createVerifyStage } from '../verify.js';
import { recordedToolFailures, runtimeExecutionEvidenceGap } from './task-state.js';

function invocation(
  callId: string,
  status: ToolInvocationRecord['status'],
  errorKind?: string,
): ToolInvocationRecord {
  return {
    version: 1,
    id: `record-${callId}`,
    callId,
    runId: 'run-1',
    sessionId: 'test-session',
    toolName: 'exec',
    toolSource: 'builtin',
    status,
    proposedAt: '2026-09-23T00:00:00.000Z',
    approval: { required: false, decision: 'not_required' },
    evidenceIds: [],
    ...(errorKind ? { errorKind } : {}),
  } as ToolInvocationRecord;
}

function result(callId: string, ok: boolean): ToolResult {
  return { callId, ok, ...(ok ? { output: 'ok' } : { error: 'exit code 1' }) };
}

function effect(callId: string | undefined, status: SideEffectCheckpoint['status']): SideEffectCheckpoint {
  return {
    idempotencyKey: `tool:exec:${callId ?? 'unknown'}`,
    inputHash: 'a'.repeat(64),
    toolName: 'exec',
    ...(callId ? { callId } : {}),
    resourceKeys: [],
    effectKind: 'external',
    status,
    startedAt: '2026-09-23T00:00:00.000Z',
    ...(status === 'succeeded' || status === 'failed' || status === 'cancelled'
      ? { endedAt: '2026-09-23T00:00:01.000Z', evidenceRef: `tool:${callId ?? 'unknown'}` }
      : {}),
  } as SideEffectCheckpoint;
}

function stepWithResults(ids: string[], results: ToolResult[]): TaskStepResult {
  return {
    stepId: 'step-1',
    description: 'run the command',
    status: 'done',
    startedAt: '2026-09-23T00:00:00.000Z',
    endedAt: '2026-09-23T00:00:01.000Z',
    toolCallIds: ids,
    toolResults: results,
  } as TaskStepResult;
}

function context(): RunContext {
  const ctx = makeCtx({ inbound: textMessage('user', 'run the command') });
  ctx.toolResults = [];
  ctx.toolInvocations = [];
  ctx.sideEffects = [];
  return ctx;
}

describe('the evidence gap a completed run reports', () => {
  it('passes a normal completion and a recorded failure', () => {
    const completed = context();
    completed.toolInvocations = [invocation('call-1', 'succeeded')];
    completed.toolResults = [result('call-1', true)];
    expect(runtimeExecutionEvidenceGap(completed)).toBeUndefined();

    // A recorded negative outcome is evidence, not a gap: the runtime knows
    // exactly what happened.
    const failedRun = context();
    failedRun.toolInvocations = [invocation('call-1', 'failed')];
    failedRun.toolResults = [result('call-1', false)];
    failedRun.sideEffects = [effect('call-1', 'failed')];
    expect(runtimeExecutionEvidenceGap(failedRun)).toBeUndefined();
  });

  it('reports a genuinely missing result when the invocation record outlived it', () => {
    // The boundary the message is for: the invocation was published, then the
    // run was cut short before its result was written back.
    const ctx = context();
    ctx.toolInvocations = [invocation('call-1', 'running')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('tool result call-1 is missing');
  });

  it('keeps a blocked invocation a status gap, not a missing-result gap', () => {
    const ctx = context();
    ctx.toolInvocations = [invocation('call-1', 'approval_denied', 'approval_denied')];
    ctx.toolResults = [result('call-1', false)];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('tool invocation call-1 is approval_denied');
  });

  it('reports duplicate call ids and truncated invocation evidence by name', () => {
    const duplicated = context();
    duplicated.toolInvocations = [invocation('call-1', 'succeeded'), invocation('call-1', 'succeeded')];
    duplicated.toolResults = [result('call-1', true)];
    expect(runtimeExecutionEvidenceGap(duplicated)).toBe('duplicate tool invocation call-1');

    const truncated = context();
    truncated.toolInvocations = [invocation('call-1', 'succeeded')];
    truncated.toolResults = [result('call-1', true)];
    truncated.toolInvocationsTruncated = true;
    expect(runtimeExecutionEvidenceGap(truncated)).toBe('tool invocation evidence is truncated');
  });

  it('reports an unsettled side effect and never treats it as settled evidence', () => {
    const ctx = context();
    ctx.sideEffects = [effect('call-1', 'unknown')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('side effect tool:exec:call-1 is unknown');
  });

  // CE-07/CE-09: which refusals are unusable evidence and which are recorded
  // outcomes. The question is what the Runtime knows, not how bad the outcome was.
  it('treats a Runtime-issued refusal as a recorded outcome, not a gap', () => {
    for (const status of ['validation_failed', 'unknown_tool', 'repeated_call_blocked'] as const) {
      const ctx = context();
      ctx.toolInvocations = [invocation('call-1', status, 'input_validation')];
      ctx.toolResults = [result('call-1', false)];

      // The call was refused before it ran, so the Runtime knows exactly what
      // happened — nothing. The run keeps its delivery; the refusal keeps the
      // verdict away from `pass`.
      expect(runtimeExecutionEvidenceGap(ctx), status).toBeUndefined();
      expect(recordedToolFailures(ctx), status).toEqual([`tool invocation call-1 is ${status}`]);
    }
  });

  it('keeps a permission outcome a gap the user has to resolve, and lets a later success supersede it', () => {
    const refused = invocation('call-1', 'approval_denied', 'approval_denied');
    refused.stepId = 'step-1';
    const stranded = context();
    stranded.toolInvocations = [refused];
    stranded.toolResults = [result('call-1', false)];
    // Nobody decided whether the access is granted, so the run escalates with it.
    expect(runtimeExecutionEvidenceGap(stranded)).toBe('tool invocation call-1 is approval_denied');

    // Once a later call in the same step succeeded, that outcome is the run's
    // word on the step and the refusal is superseded.
    const superseded = context();
    superseded.toolInvocations = [refused, { ...invocation('call-2', 'succeeded'), stepId: 'step-1' }];
    superseded.toolResults = [result('call-1', false), result('call-2', true)];
    expect(runtimeExecutionEvidenceGap(superseded)).toBeUndefined();

    // A later call recorded for a *different* step does not supersede it.
    const otherStep = context();
    otherStep.toolInvocations = [refused, { ...invocation('call-2', 'succeeded'), stepId: 'step-2' }];
    otherStep.toolResults = [result('call-1', false), result('call-2', true)];
    expect(runtimeExecutionEvidenceGap(otherStep)).toBe('tool invocation call-1 is approval_denied');
  });
});

// CE-09's compatibility question: the deleted step executor cannot refuse a tool
// any more, but a checkpoint written before it was deleted still carries a plan
// and its step results. The documented rule is that step evidence is owed only
// for a plan this run executed — and the code did not implement it, so a resumed
// legacy run was judged incomplete on history it had not touched and was sent
// back into the loop to re-plan steps no executor can run.
function legacyPlanContext(status: 'failed' | 'done'): RunContext {
  const ctx = context();
  ctx.resumedFromCheckpointId = 'checkpoint-legacy';
  ctx.taskBook = {
    assessment: {
      userNeed: 'do the work',
      complexity: 'standard',
      goal: 'do the work',
      successCriteria: ['work is done'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'do the work',
    complexity: 'standard',
    successCriteria: ['work is done'],
    steps: [
      { id: 'step-1', description: 'first' },
      { id: 'step-2', description: 'second' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
  } as NonNullable<RunContext['taskBook']>;
  ctx.taskExecution = {
    goal: 'do the work',
    complexity: 'standard',
    status,
    startedAt: '2026-09-23T00:00:00.000Z',
    steps: [
      stepWithResults(['call-1'], [result('call-1', true)]),
      {
        stepId: 'step-2',
        description: 'second',
        status: status === 'done' ? 'done' : 'failed',
        startedAt: '2026-09-23T00:00:01.000Z',
        endedAt: '2026-09-23T00:00:02.000Z',
        failureKind: status === 'done' ? undefined : 'tool_error',
        toolCallIds: [],
        toolResults: [],
      },
    ],
  } as NonNullable<RunContext['taskExecution']>;
  return ctx;
}

describe('step evidence for a plan this run did not execute', () => {
  it('does not owe step evidence for a plan restored from a checkpoint', () => {
    const ctx = legacyPlanContext('failed');
    ctx.sideEffects = [effect('call-1', 'succeeded')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });

  it('does not owe it for a restored plan whose execution status is not done either', () => {
    const ctx = legacyPlanContext('failed');
    // No steps at all, only the inherited execution header: the second branch of
    // the old check fired on the status alone.
    ctx.taskBook = undefined;

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });

  it('still owes it for a plan this run executed', () => {
    const ctx = legacyPlanContext('failed');
    // No resume marker: the plan belongs to this run, so an incomplete execution
    // is a real gap and the verdict must not pass.
    ctx.resumedFromCheckpointId = undefined;

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('failed or missing task step evidence');
  });
});

// The defect this investigation confirmed: a resumed run inherits the ledger it
// was checkpointed with, but the restored context starts with an empty
// invocation list, so every inherited settled effect looked unattested. Any
// resumed run that finished its work reported incomplete evidence about effects
// the runtime had already settled.
describe('a resumed run and the ledger it inherited', () => {
  it('accepts a settled effect that the checkpoint carried forward', () => {
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.sideEffects = [effect('call-1', 'succeeded'), effect('call-2', 'failed')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });

  it('keeps accepting the inherited ledger after the new run executes something', () => {
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.sideEffects = [effect('call-1', 'succeeded')];
    // The continuation runs its own tool: the invocation list now describes this
    // run, which is exactly when the inherited call id stops matching.
    ctx.toolInvocations = [invocation('call-9', 'succeeded')];
    ctx.toolResults = [result('call-9', true)];

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });

  it('still reports an inherited effect that was never settled', () => {
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.sideEffects = [effect('call-1', 'in_progress')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('side effect tool:exec:call-1 is in_progress');
  });

  it('does not credit inheritance to a run that did not resume', () => {
    const ctx = context();
    ctx.sideEffects = [effect('call-1', 'succeeded')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('side effect tool:exec:call-1 has no matching tool invocation');
  });

  it('counts a recorded failed outcome in a legacy checkpoint step as evidence', () => {
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.taskExecution = {
      goal: 'run the command',
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-09-23T00:00:00.000Z',
      steps: [stepWithResults(['call-1'], [result('call-1', false)])],
    } as NonNullable<RunContext['taskExecution']>;
    ctx.sideEffects = [effect('call-1', 'failed')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });

  it('still reports an inherited effect that carries no call id at all', () => {
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.taskExecution = {
      goal: 'run the command',
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-09-23T00:00:00.000Z',
      steps: [stepWithResults(['call-2'], [result('call-2', true)])],
    } as NonNullable<RunContext['taskExecution']>;
    ctx.sideEffects = [effect(undefined, 'succeeded')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBe('side effect tool:exec:unknown has no matching tool invocation');
  });

  it('credits the restored ledger itself, not only a legacy step record', () => {
    // The step evidence in a legacy checkpoint names a different call. The
    // ledger entry is still the Runtime's own settled record of an invocation it
    // made before the interruption, and the ledger is what the checkpoint
    // carried forward — so the effect has an outcome, which is what the check
    // asks for.
    const ctx = context();
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.taskExecution = {
      goal: 'run the command',
      complexity: 'standard',
      status: 'done',
      startedAt: '2026-09-23T00:00:00.000Z',
      steps: [stepWithResults(['call-2'], [result('call-2', true)])],
    } as NonNullable<RunContext['taskExecution']>;
    ctx.sideEffects = [effect('call-1', 'succeeded')];

    expect(runtimeExecutionEvidenceGap(ctx)).toBeUndefined();
  });
});

describe('what the resumed run settles on', () => {
  it('publishes the answer as unverified instead of routing to recovery', async () => {
    const ctx = context();
    ctx.reply = 'the command ran and the file is in place';
    ctx.replyProvenance = {
      version: 1,
      source: 'llm',
      purpose: 'execute_tool_loop',
      modelRequestId: 'model-request-1',
      modelRequestIndex: 1,
      provider: 'deepseek',
      model: 'deepseek-flash',
      generatedAt: '2026-09-23T00:00:00.000Z',
      rewriteCount: 0,
    };
    ctx.resumedFromCheckpointId = 'checkpoint-1';
    ctx.sideEffects = [effect('call-1', 'succeeded')];

    const result = await createVerifyStage()(ctx);

    expect(result).toMatchObject({ ok: true, next: 'finalize' });
    expect(result.meta).toMatchObject({ verdict: 'unverified' });
    // The recorded effect is still evidence the verdict may not erase, and no
    // model request was spent deciding it.
    expect(ctx.verificationHistory?.at(-1)?.verdict).toBe('unverified');
  });
});
