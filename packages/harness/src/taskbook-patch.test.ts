import { describe, expect, it } from 'vitest';
import type { TaskBook } from '@littlesheep/types';
import {
  MAX_TASK_BOOK_PATCH_OPERATIONS,
  applyTaskBookPatch,
  applyTaskBookPatchToContext,
} from './taskbook-patch.js';

function taskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'finish the task',
      complexity: 'standard',
      goal: 'Finish the task',
      successCriteria: ['The result is verified.'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'Finish the task',
    complexity: 'standard',
    successCriteria: ['The result is verified.'],
    steps: [
      { id: 'step-1', description: 'Prepare the input.', status: 'done' },
      { id: 'step-2', description: 'Produce the result.', status: 'pending' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'Stay proportional.' },
    stageResults: [{
      stepId: 'step-1',
      description: 'Prepare the input.',
      status: 'done',
      startedAt: '2026-07-18T10:00:00.000Z',
      toolCallIds: ['call-1'],
      toolResults: [],
    }],
  };
}

function patch(operations: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'patch-1',
    runId: 'run-1',
    baseRevision: 1,
    nextRevision: 2,
    eventIds: ['event-1'],
    reason: 'The user supplied a focused change.',
    operations,
    createdAt: '2026-07-18T10:00:01.000Z',
    ...overrides,
  };
}

describe('TaskBook patch boundary', () => {
  it('updates a pending step and preserves completed evidence', () => {
    const result = applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step',
      stepId: 'step-2',
      patch: { description: 'Produce and verify the result.', acceptanceCriteria: ['The result is checked.'] },
    }]), { runId: 'run-1', currentRevision: 1, claimedEventIds: ['event-1'] });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.revision).toBe(2);
    expect(result.taskBook.steps[1]).toMatchObject({
      id: 'step-2',
      description: 'Produce and verify the result.',
      status: 'pending',
    });
    expect(result.taskBook.stageResults?.[0]).toMatchObject({ stepId: 'step-1', status: 'done' });
  });

  it('adds and removes only pending steps', () => {
    const added = applyTaskBookPatch(taskBook(), patch([{
      type: 'add_step',
      afterStepId: 'step-2',
      step: { id: 'step-3', description: 'Publish the result.', status: 'pending' },
    }]), { runId: 'run-1', currentRevision: 1 });
    expect(added.kind).toBe('applied');
    if (added.kind !== 'applied') return;

    const removed = applyTaskBookPatch(added.taskBook, patch([{
      type: 'remove_pending_step',
      stepId: 'step-3',
    }], { id: 'patch-2', baseRevision: 2, nextRevision: 3 }), {
      runId: 'run-1',
      currentRevision: 2,
    });
    expect(removed.kind).toBe('applied');
    if (removed.kind === 'applied') expect(removed.taskBook.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('validates parallel execution contracts and dependency order', () => {
    const applied = applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step',
      stepId: 'step-2',
      patch: {
        execution: {
          mode: 'parallel',
          dependsOn: ['step-1'],
          resources: [{ key: 'workspace:result.txt', mode: 'write' }],
          sideEffect: 'write',
        },
      },
    }]), { runId: 'run-1', currentRevision: 1 });
    expect(applied.kind).toBe('applied');
    if (applied.kind === 'applied') {
      expect(applied.taskBook.steps[1]?.execution).toMatchObject({ mode: 'parallel', dependsOn: ['step-1'] });
    }

    expect(applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step',
      stepId: 'step-2',
      patch: { execution: { mode: 'parallel', dependsOn: ['missing'], sideEffect: 'none' } },
    }]), { runId: 'run-1', currentRevision: 1 })).toMatchObject({ kind: 'rejected', reason: 'unknown-step' });
  });

  it('rejects revision conflicts, event mismatches, and protected steps', () => {
    expect(applyTaskBookPatch(taskBook(), patch([{ type: 'update_goal', goal: 'new goal' }], { baseRevision: 2, nextRevision: 3 }), {
      runId: 'run-1', currentRevision: 1,
    })).toMatchObject({ kind: 'rejected', reason: 'revision-conflict' });

    expect(applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step', stepId: 'step-2', patch: { title: 'new' },
    }]), { runId: 'run-1', currentRevision: 1, claimedEventIds: ['other-event'] })).toMatchObject({
      kind: 'rejected', reason: 'event-mismatch',
    });

    expect(applyTaskBookPatch(taskBook(), patch([{
      type: 'remove_pending_step', stepId: 'step-1',
    }]), { runId: 'run-1', currentRevision: 1 })).toMatchObject({
      kind: 'rejected', reason: 'protected-step',
    });
  });

  it('makes duplicate patches idempotent and rejects unsafe operation counts', () => {
    const first = applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step', stepId: 'step-2', patch: { title: 'updated' },
    }]), { runId: 'run-1', currentRevision: 1 });
    expect(first.kind).toBe('applied');
    expect(applyTaskBookPatch(taskBook(), patch([{
      type: 'update_pending_step', stepId: 'step-2', patch: { title: 'updated' },
    }]), {
      runId: 'run-1', currentRevision: 2, appliedPatchIds: ['patch-1'],
    })).toMatchObject({ kind: 'duplicate', revision: 2 });

    const tooMany = Array.from({ length: MAX_TASK_BOOK_PATCH_OPERATIONS + 1 }, () => ({
      type: 'update_goal', goal: 'same goal',
    }));
    expect(applyTaskBookPatch(taskBook(), patch(tooMany), {
      runId: 'run-1', currentRevision: 1,
    })).toMatchObject({ kind: 'rejected', reason: 'operation-limit' });
  });

  it('commits the patch to RunContext and records its bounded id', () => {
    const ctx = {
      runId: 'run-1',
      taskBook: taskBook(),
      taskBookRevision: 1,
      appliedTaskBookPatchIds: [],
      plan: taskBook().steps,
    } as never;
    const result = applyTaskBookPatchToContext(ctx, patch([{
      type: 'update_goal', goal: 'A more precise goal',
    }]), ['event-1']);

    expect(result.kind).toBe('applied');
    expect(ctx.taskBookRevision).toBe(2);
    expect(ctx.appliedTaskBookPatchIds).toEqual(['patch-1']);
    expect(ctx.taskBook?.goal).toBe('A more precise goal');
  });
});
