import { describe, expect, it } from 'vitest';
import { runRunnerCoordinator, type RunnerCoordinator } from './runner-coordinator.js';

describe('runner coordinator', () => {
  it('passes the prepared and executed records through prepare, execute, finalize, persist', async () => {
    const phases: string[] = [];
    const coordinator: RunnerCoordinator<{ value: number }, { value: number }> = {
      async prepare() {
        phases.push('prepare');
        return { ctx: { value: 1 }, sessionId: 'session', inboundText: 'hello' };
      },
      async execute(prepared) {
        phases.push(`execute:${prepared.ctx.value}`);
        return { prepared, stageResult: { stage: 'execute', next: 'exit', ok: true }, runStopped: false };
      },
      async finalize(executed) {
        phases.push(`finalize:${executed.stageResult.ok}`);
        return { ...executed, result: { value: executed.prepared.ctx.value + 1 } };
      },
      async persist(finalized) {
        phases.push(`persist:${finalized.result.value}`);
      },
    };

    await expect(runRunnerCoordinator(coordinator)).resolves.toEqual({ value: 2 });
    expect(phases).toEqual(['prepare', 'execute:1', 'finalize:true', 'persist:2']);
  });

  it('does not persist when preparation, execution, or finalization fails', async () => {
    const failures = ['prepare', 'execute', 'finalize'] as const;
    for (const failure of failures) {
      const phases: string[] = [];
      const coordinator: RunnerCoordinator<null, string> = {
        async prepare() {
          phases.push('prepare');
          if (failure === 'prepare') throw new Error(failure);
          return { ctx: null, sessionId: 'session', inboundText: '' };
        },
        async execute(prepared) {
          phases.push('execute');
          if (failure === 'execute') throw new Error(failure);
          return { prepared, stageResult: { stage: 'execute', next: 'exit', ok: true }, runStopped: false };
        },
        async finalize(executed) {
          phases.push('finalize');
          if (failure === 'finalize') throw new Error(failure);
          return { ...executed, result: 'ok' };
        },
        async persist() {
          phases.push('persist');
        },
      };

      await expect(runRunnerCoordinator(coordinator)).rejects.toThrow(failure);
      expect(phases).not.toContain('persist');
    }
  });

  it('propagates persistence failures to the caller', async () => {
    const coordinator: RunnerCoordinator<null, string> = {
      async prepare() { return { ctx: null, sessionId: 'session', inboundText: '' }; },
      async execute(prepared) {
        return { prepared, stageResult: { stage: 'execute', next: 'exit', ok: true }, runStopped: false };
      },
      async finalize(executed) { return { ...executed, result: 'ok' }; },
      async persist() { throw new Error('persist failed'); },
    };

    await expect(runRunnerCoordinator(coordinator)).rejects.toThrow('persist failed');
  });
});
