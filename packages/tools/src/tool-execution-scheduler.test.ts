import { describe, expect, it } from 'vitest';
import {
  buildToolExecutionWaves,
  executeToolWaves,
  type ScheduledToolExecution,
} from './tool-execution-scheduler.js';

describe('tool execution scheduler', () => {
  it('packs independent calls into bounded parallel waves', () => {
    const waves = buildToolExecutionWaves([
      call(0, 'parallel', [{ key: 'fs:a', mode: 'read' }]),
      call(1, 'parallel', [{ key: 'fs:b', mode: 'write' }]),
      call(2, 'parallel', [{ key: 'fs:c', mode: 'read' }]),
    ], 2);

    expect(waves.map((wave) => wave.map((item) => item.index))).toEqual([[0, 1], [2]]);
  });

  it('serializes read-write conflicts while allowing read-read overlap', () => {
    const waves = buildToolExecutionWaves([
      call(0, 'parallel', [{ key: 'fs:a', mode: 'read' }]),
      call(1, 'parallel', [{ key: 'fs:a', mode: 'read' }]),
      call(2, 'parallel', [{ key: 'fs:a', mode: 'write' }]),
    ], 4);

    expect(waves.map((wave) => wave.map((item) => item.index))).toEqual([[0, 1], [2]]);
  });

  it('keeps exclusive calls alone', () => {
    const waves = buildToolExecutionWaves([
      call(0, 'parallel', []),
      call(1, 'exclusive', []),
      call(2, 'parallel', []),
    ], 4);

    expect(waves.map((wave) => wave.map((item) => item.index))).toEqual([[0], [1], [2]]);
  });

  it('returns results by original index when completion order differs', async () => {
    const calls: ScheduledToolExecution<string>[] = [
      { ...call(0, 'parallel', []), execute: () => delay('first', 10) },
      { ...call(1, 'parallel', []), execute: () => delay('second', 1) },
    ];

    const results = await executeToolWaves(calls, 4);

    expect(results.get(0)).toBe('first');
    expect(results.get(1)).toBe('second');
  });
});

function call(
  index: number,
  concurrency: 'parallel' | 'exclusive',
  resources: ScheduledToolExecution<never>['resources'],
): ScheduledToolExecution<never> {
  return { index, concurrency, resources, execute: async () => undefined as never };
}

async function delay<T>(value: T, milliseconds: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return value;
}
