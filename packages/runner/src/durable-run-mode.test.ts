import { describe, expect, it } from 'vitest';
import { readDurableHarnessMode } from './durable-run-mode.js';

function store(events: unknown[]) {
  return { read: async () => events } as never;
}

describe('durable run mode lookup', () => {
  it('reads the mode the run actually recorded', async () => {
    const events = [
      { type: 'run_accepted', payload: { durableHarnessMode: 'shadow' } },
      { type: 'run_completed', payload: {} },
    ];
    expect(await readDurableHarnessMode(store(events), 'session-1', 'run-1')).toBe('shadow');
  });

  it('treats runs that predate the recorded field as next so settlement still gates them', async () => {
    const events = [{ type: 'run_accepted', payload: {} }, { type: 'final_reply_proposed', payload: {} }];
    expect(await readDurableHarnessMode(store(events), 'session-1', 'run-1')).toBe('next');
  });

  it('reports no mode when no durable facts exist for the run', async () => {
    expect(await readDurableHarnessMode(store([]), 'session-1', 'missing')).toBeUndefined();
  });
});