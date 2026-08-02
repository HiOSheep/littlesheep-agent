import { describe, expect, it } from 'vitest';
import { parallelFilePolicy } from '@littlesheep/tools';
import { asSessionId, type TaskBook, type ToolContext } from '@littlesheep/types';
import { makeTool } from '../../tests/helpers.js';
import {
  buildTaskStepGraph,
  nextTaskStepWave,
} from './task-step-scheduler.js';

describe('TaskBook step scheduler', () => {
  it('selects independent parallel steps before a serial barrier', () => {
    const graph = buildTaskStepGraph(taskBook([
      parallelStep('inspect-a', 'workspace:a', 'read'),
      parallelStep('inspect-b', 'workspace:b', 'read'),
      { id: 'combine', description: 'combine results' },
    ]), [parallelTool()], toolContext());
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    expect(nextTaskStepWave(graph.steps, new Set(['inspect-a', 'inspect-b', 'combine']), new Set(), 2)
      .map((step) => step.id)).toEqual(['inspect-a', 'inspect-b']);
    expect(nextTaskStepWave(graph.steps, new Set(['combine']), new Set(['inspect-a', 'inspect-b']), 2)
      .map((step) => step.id)).toEqual(['combine']);
  });

  it('does not overlap a directory write with a nested file read', () => {
    const graph = buildTaskStepGraph(taskBook([
      parallelStep('write-dir', 'workspace:src', 'write'),
      parallelStep('read-file', 'workspace:src/index.ts', 'read'),
    ]), [parallelTool()], toolContext());
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    expect(nextTaskStepWave(graph.steps, new Set(['write-dir', 'read-file']), new Set(), 2)
      .map((step) => step.id)).toEqual(['write-dir']);
  });

  it('downgrades incomplete, approval-bound, and restricted policies to serial', () => {
    const approvalTool = parallelTool();
    approvalTool.requiresApproval = true;
    const graph = buildTaskStepGraph(taskBook([
      { ...parallelStep('missing-effect', 'workspace:a', 'read'), execution: { mode: 'parallel', resources: [{ key: 'workspace:a', mode: 'read' }] } },
      parallelStep('approval', 'workspace:b', 'read', 'probe'),
      parallelStep('restricted', 'workspace:c', 'read'),
    ]), [approvalTool], toolContext('restricted'));
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.steps.map((step) => step.mode)).toEqual(['serial', 'serial', 'serial']);
    expect(graph.steps.every((step) => Boolean(step.downgradeReason))).toBe(true);
  });

  it('does not serialize parallel tools solely because full access metadata requires approval', () => {
    const approvalTool = parallelTool();
    approvalTool.requiresApproval = true;
    const step = parallelStep('full-access', 'workspace:a', 'read', 'probe');
    step.requiresApproval = true;
    const graph = buildTaskStepGraph(taskBook([step]), [approvalTool], toolContext('full'));

    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.steps[0]?.mode).toBe('parallel');
    expect(graph.steps[0]?.downgradeReason).toBeUndefined();
  });

  it('rejects missing and forward dependencies before execution starts', () => {
    const missing = buildTaskStepGraph(taskBook([
      { ...parallelStep('a', 'workspace:a', 'read'), execution: { ...parallelStep('a', 'workspace:a', 'read').execution!, dependsOn: ['missing'] } },
    ]), [parallelTool()], toolContext());
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('unknown step') });

    const forward = buildTaskStepGraph(taskBook([
      { ...parallelStep('a', 'workspace:a', 'read'), execution: { ...parallelStep('a', 'workspace:a', 'read').execution!, dependsOn: ['b'] } },
      parallelStep('b', 'workspace:b', 'read'),
    ]), [parallelTool()], toolContext());
    expect(forward).toMatchObject({ ok: false, error: expect.stringContaining('earlier steps') });
  });
});

function taskBook(steps: TaskBook['steps']): TaskBook {
  return {
    assessment: {
      userNeed: 'test scheduling',
      complexity: 'standard',
      goal: 'test scheduling',
      successCriteria: ['steps complete'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1,
    },
    goal: 'test scheduling',
    complexity: 'standard',
    successCriteria: ['steps complete'],
    steps,
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay in scope' },
  };
}

function parallelStep(id: string, key: string, mode: 'read' | 'write', tool = 'probe'): TaskBook['steps'][number] {
  return {
    id,
    description: id,
    tools: [tool],
    execution: {
      mode: 'parallel',
      resources: [{ key, mode }],
      sideEffect: mode,
    },
  };
}

function parallelTool() {
  const tool = makeTool('probe', { ok: true, output: 'ok' });
  tool.execution = parallelFilePolicy('path', 'read');
  return tool;
}

function toolContext(permissionMode: ToolContext['permissionMode'] = 'full'): ToolContext {
  return {
    sessionId: asSessionId('scheduler-session'),
    runId: 'scheduler-run',
    cwd: process.cwd(),
    containerRoot: process.cwd(),
    permissionMode,
  };
}
