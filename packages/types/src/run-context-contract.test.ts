import { describe, expect, it } from 'vitest';
import {
  assertRunContextFieldWriteAllowed,
  canWriteRunContextField,
  getRunContextFieldContract,
  runContextFieldsForGroup,
} from './run-context-contract.js';

describe('RunContext ownership contract', () => {
  it('assigns the four high-churn groups to explicit owners', () => {
    for (const group of ['reply', 'replan', 'runtimeControl', 'memory'] as const) {
      const definitions = runContextFieldsForGroup(group);
      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions.every((definition) => definition.owner.length > 0)).toBe(true);
      expect(definitions.every((definition) => definition.readStages.length > 0)).toBe(true);
      expect(definitions.every((definition) => definition.writeStages.length > 0)).toBe(true);
    }
  });

  it('describes reply and taskBook lifecycle boundaries', () => {
    expect(getRunContextFieldContract('reply')).toMatchObject({
      group: 'reply',
      owner: 'user-facing-reply-boundary',
      lifecycle: 'run-local',
    });
    expect(getRunContextFieldContract('taskBook')).toMatchObject({
      group: 'replan',
      owner: 'decide-taskbook-boundary',
      lifecycle: 'checkpoint-carried',
    });
  });

  it('exposes explicit write checks without changing the RunContext shape', () => {
    expect(canWriteRunContextField('reply', 'reply')).toBe(true);
    expect(canWriteRunContextField('reply', 'verify')).toBe(false);
    expect(canWriteRunContextField('taskBook', 'runtime-boundary')).toBe(true);
    expect(() => assertRunContextFieldWriteAllowed('reply', 'verify')).toThrow(/cannot be written/);
    expect(() => assertRunContextFieldWriteAllowed('reply', 'reply')).not.toThrow();
  });
});
