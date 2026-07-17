// Bounded aggregation for coarse per-run resource samples used by Memory v3 calibration.

import type { RuntimeResourceObservation } from './runtime-resource-observation.js';

const MAX_DEVICE_CLASSES = 32;

export interface MemoryWorkloadResourceSummary {
  sampledRuns: number;
  deviceClasses: Record<string, number>;
  deviceClassesTruncated: boolean;
  rssBytes: {
    averageStart: number | null;
    averageEnd: number | null;
    averageDelta: number | null;
    maximumEnd: number;
    maximumIncrease: number;
  };
  heapUsedBytes: {
    averageStart: number | null;
    averageEnd: number | null;
    averageDelta: number | null;
    maximumEnd: number;
    maximumIncrease: number;
  };
}

export class MemoryWorkloadResourceAccumulator {
  private sampledRuns = 0;
  private readonly deviceClasses: Record<string, number> = {};
  private deviceClassesTruncated = false;
  private rssStartTotal = 0;
  private rssEndTotal = 0;
  private rssDeltaTotal = 0;
  private rssMaximumEnd = 0;
  private rssMaximumIncrease = 0;
  private heapStartTotal = 0;
  private heapEndTotal = 0;
  private heapDeltaTotal = 0;
  private heapMaximumEnd = 0;
  private heapMaximumIncrease = 0;

  observe(value: RuntimeResourceObservation | undefined): boolean {
    if (!isRuntimeResourceObservation(value)) return false;
    this.sampledRuns += 1;
    this.observeDeviceClass(deviceClassKey(value));
    const rssDelta = value.end.rssBytes - value.start.rssBytes;
    const heapDelta = value.end.heapUsedBytes - value.start.heapUsedBytes;
    this.rssStartTotal += value.start.rssBytes;
    this.rssEndTotal += value.end.rssBytes;
    this.rssDeltaTotal += rssDelta;
    this.rssMaximumEnd = Math.max(this.rssMaximumEnd, value.end.rssBytes);
    this.rssMaximumIncrease = Math.max(this.rssMaximumIncrease, rssDelta);
    this.heapStartTotal += value.start.heapUsedBytes;
    this.heapEndTotal += value.end.heapUsedBytes;
    this.heapDeltaTotal += heapDelta;
    this.heapMaximumEnd = Math.max(this.heapMaximumEnd, value.end.heapUsedBytes);
    this.heapMaximumIncrease = Math.max(this.heapMaximumIncrease, heapDelta);
    return true;
  }

  snapshot(): MemoryWorkloadResourceSummary {
    return {
      sampledRuns: this.sampledRuns,
      deviceClasses: { ...this.deviceClasses },
      deviceClassesTruncated: this.deviceClassesTruncated,
      rssBytes: metricSummary(
        this.sampledRuns,
        this.rssStartTotal,
        this.rssEndTotal,
        this.rssDeltaTotal,
        this.rssMaximumEnd,
        this.rssMaximumIncrease,
      ),
      heapUsedBytes: metricSummary(
        this.sampledRuns,
        this.heapStartTotal,
        this.heapEndTotal,
        this.heapDeltaTotal,
        this.heapMaximumEnd,
        this.heapMaximumIncrease,
      ),
    };
  }

  private observeDeviceClass(key: string): void {
    if (Object.hasOwn(this.deviceClasses, key)) {
      this.deviceClasses[key] = (this.deviceClasses[key] ?? 0) + 1;
      return;
    }
    if (Object.keys(this.deviceClasses).length >= MAX_DEVICE_CLASSES) {
      this.deviceClassesTruncated = true;
      this.deviceClasses.other = (this.deviceClasses.other ?? 0) + 1;
      return;
    }
    this.deviceClasses[key] = 1;
  }
}

function metricSummary(
  count: number,
  startTotal: number,
  endTotal: number,
  deltaTotal: number,
  maximumEnd: number,
  maximumIncrease: number,
): MemoryWorkloadResourceSummary['rssBytes'] {
  return {
    averageStart: average(startTotal, count),
    averageEnd: average(endTotal, count),
    averageDelta: average(deltaTotal, count),
    maximumEnd,
    maximumIncrease: Math.max(0, maximumIncrease),
  };
}

function average(total: number, count: number): number | null {
  return count > 0 ? Math.round(total / count) : null;
}

function deviceClassKey(value: RuntimeResourceObservation): string {
  const platform = safeLabel(value.device.platform);
  const arch = safeLabel(value.device.arch);
  return `${platform}/${arch}/memory-${value.device.totalMemoryMiBBucket}/cpu-${value.device.logicalCpuBucket}`;
}

function safeLabel(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/iu.test(value) ? value.toLowerCase() : 'other';
}

function isRuntimeResourceObservation(value: unknown): value is RuntimeResourceObservation {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Partial<RuntimeResourceObservation>;
  return observation.version === 1
    && isPositiveInteger(observation.device?.totalMemoryMiBBucket)
    && isPositiveInteger(observation.device?.logicalCpuBucket)
    && isResourceSample(observation.start)
    && isResourceSample(observation.end);
}

function isResourceSample(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Record<string, unknown>;
  return isNonNegativeNumber(sample.rssBytes) && isNonNegativeNumber(sample.heapUsedBytes);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
