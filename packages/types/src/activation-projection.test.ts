import { describe, expect, it } from 'vitest';
import { AtomicActivationLevelTracker } from './activation-projection.js';

describe('AtomicActivationLevelTracker', () => {
  it('keeps UI levels stable across threshold jitter and releases removed entries', () => {
    const tracker = new AtomicActivationLevelTracker(4);

    expect(tracker.project([{ id: 'atom-a', score: 0.65 }])).toEqual({ high: 0, medium: 1, low: 0 });
    expect(tracker.project([{ id: 'atom-a', score: 0.67 }])).toEqual({ high: 0, medium: 1, low: 0 });
    expect(tracker.project([{ id: 'atom-a', score: 0.72 }])).toEqual({ high: 1, medium: 0, low: 0 });
    expect(tracker.project([{ id: 'atom-a', score: 0.63 }])).toEqual({ high: 1, medium: 0, low: 0 });
    expect(tracker.project([{ id: 'atom-a', score: 0.6 }])).toEqual({ high: 0, medium: 1, low: 0 });

    expect(tracker.project([])).toEqual({ high: 0, medium: 0, low: 0 });
    expect(tracker.size).toBe(0);
  });

  it('bounds retained projection state and ignores duplicate ids', () => {
    const tracker = new AtomicActivationLevelTracker(2);

    expect(tracker.project([
      { id: 'first', score: 0.8 },
      { id: 'first', score: 0.1 },
      { id: 'second', score: 0.4 },
      { id: 'third', score: 0.2 },
    ])).toEqual({ high: 1, medium: 1, low: 0 });
    expect(tracker.size).toBe(2);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it('rejects an invalid retention bound', () => {
    expect(() => new AtomicActivationLevelTracker(0)).toThrow(/positive integer/i);
  });
});
