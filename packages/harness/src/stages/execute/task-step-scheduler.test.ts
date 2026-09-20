// TaskBook dependency validation and serial step selection. Parallel waves are
// gone with the second execution system, so this file only proves that a plan is
// executable and picks the next step in plan order.
import { describe, expect, it } from 'vitest';
import { parallelFilePolicy } from '@littlesheep/tools';
import { asSessionId, type TaskBook, type ToolContext } from '@littlesheep/types';
import { makeTool } from '../../tests/helpers.js';
import { buildTaskStepGraph, nextTaskStep } from './task-step-scheduler.js';

describe('TaskBook step graph', () => {
  it('selects the first pending step whose dependencies are completed', () => {
    const step = (id: string, dependsOn: string[] = []): TaskBook['steps'][number] => ({
      id,
      description: id,
      tools: ['probe'],
      execution: { mode: 'serial', sideEffect: 'read', dependsOn, resources: [{ key: `workspace:${id}`, mode: 'read' }] },
    });
    const graph = buildTaskStepGraph(taskBook([
      step('first'),
      step('second', ['first']),
      step('third'),
    ]), toolContext());
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    expect(nextTaskStep(graph.steps, new Set(['first', 'second', 'third']), new Set())?.id).toBe('first');
    expect(nextTaskStep(graph.steps, new Set(['second', 'third']), new Set(['first']))?.id).toBe('second');
    // A missing dependency keeps the dependent step blocked rather than skipping it.
    expect(nextTaskStep(graph.steps, new Set(['second']), new Set())).toBeUndefined();
  });

  it('rejects missing and forward dependencies before execution starts', () => {
    const dependent = (id: string, dependsOn: string[]): TaskBook['steps'][number] => ({
      id,
      description: id,
      tools: ['probe'],
      execution: { mode: 'serial', dependsOn, resources: [{ key: `workspace:${id}`, mode: 'read' }] },
    });
    const missing = buildTaskStepGraph(taskBook([dependent('a', ['missing'])]), toolContext());
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('unknown step') });

    const forward = buildTaskStepGraph(taskBook([dependent('a', ['b']), dependent('b', [])]), toolContext());
    expect(forward).toMatchObject({ ok: false, error: expect.stringContaining('earlier steps') });
  });

  it('normalizes declared file resources into comparable workspace keys', () => {
    const graph = buildTaskStepGraph(taskBook([{
      id: 'probe-step',
      description: 'probe-step',
      tools: ['probe'],
      execution: {
        mode: 'serial',
        sideEffect: 'read',
        resources: [{ key: 'workspace:src/index.ts', mode: 'read' }, { key: 'workspace:src/index.ts', mode: 'write' }],
      },
    }]), toolContext());
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.steps[0]?.resources).toEqual([
      { key: `fs:${process.cwd().replace(/\\/gu, '/').toLowerCase()}/src/index.ts`, mode: 'write' },
    ]);
  });

  it('keeps the declared side effect and resource envelope for permission checks', () => {
    const tool = makeTool('probe', { ok: true, output: 'ok' });
    tool.execution = parallelFilePolicy('path', 'read');
    const graph = buildTaskStepGraph(taskBook([{
      id: 'probe-step',
      description: 'probe-step',
      tools: ['probe'],
      execution: { mode: 'serial', sideEffect: 'write', resources: [{ key: 'workspace:out.txt', mode: 'write' }] },
    }]), toolContext('restricted'));

    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.steps[0]).toMatchObject({ sideEffect: 'write' });
    expect(graph.steps[0]?.resources[0]?.mode).toBe('write');
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

function toolContext(permissionMode: ToolContext['permissionMode'] = 'full'): ToolContext {
  return {
    sessionId: asSessionId('scheduler-session'),
    runId: 'scheduler-run',
    cwd: process.cwd(),
    containerRoot: process.cwd(),
    permissionMode,
  };
}
