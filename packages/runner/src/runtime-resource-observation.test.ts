import { describe, expect, it } from 'vitest';
import {
  beginRuntimeResourceObservation,
  completeRuntimeResourceObservation,
  RUNTIME_RESOURCE_OBSERVATION_VERSION,
} from './runtime-resource-observation.js';

describe('runtime resource observation', () => {
  it('captures bounded start/end samples and a coarse device class', () => {
    const times = [
      new Date('2026-07-17T00:00:00.000Z'),
      new Date('2026-07-17T00:00:01.000Z'),
    ];
    const start = beginRuntimeResourceObservation(() => times.shift()!);
    const result = completeRuntimeResourceObservation(start, () => times.shift()!);

    expect(result.version).toBe(RUNTIME_RESOURCE_OBSERVATION_VERSION);
    expect(result.start.sampledAt).toBe('2026-07-17T00:00:00.000Z');
    expect(result.end.sampledAt).toBe('2026-07-17T00:00:01.000Z');
    expect(result.start.rssBytes).toBeGreaterThan(0);
    expect(result.end.heapUsedBytes).toBeGreaterThan(0);
    expect(result.device.platform).toBe(process.platform);
    expect(result.device.arch).toBe(process.arch);
    expect(isPowerOfTwo(result.device.totalMemoryMiBBucket)).toBe(true);
    expect(isPowerOfTwo(result.device.logicalCpuBucket)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/hostname|username|computername/iu);
  });
});

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}
