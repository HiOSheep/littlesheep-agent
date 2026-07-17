// Captures two bounded process samples per run without polling or device identifiers.

import { arch, cpus, platform, totalmem } from 'node:os';

export const RUNTIME_RESOURCE_OBSERVATION_VERSION = 1 as const;

export interface RuntimeDeviceClass {
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryMiBBucket: number;
  logicalCpuBucket: number;
}

export interface RuntimeResourceSample {
  sampledAt: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface RuntimeResourceObservationStart {
  version: typeof RUNTIME_RESOURCE_OBSERVATION_VERSION;
  device: RuntimeDeviceClass;
  start: RuntimeResourceSample;
}

export interface RuntimeResourceObservation extends RuntimeResourceObservationStart {
  end: RuntimeResourceSample;
}

export function beginRuntimeResourceObservation(
  now: () => Date = () => new Date(),
): RuntimeResourceObservationStart {
  return {
    version: RUNTIME_RESOURCE_OBSERVATION_VERSION,
    device: {
      platform: platform(),
      arch: arch(),
      totalMemoryMiBBucket: powerOfTwoFloor(Math.max(1, Math.floor(totalmem() / (1024 * 1024)))),
      logicalCpuBucket: powerOfTwoFloor(Math.max(1, cpus().length)),
    },
    start: sampleRuntimeResources(now),
  };
}

export function completeRuntimeResourceObservation(
  observation: RuntimeResourceObservationStart,
  now: () => Date = () => new Date(),
): RuntimeResourceObservation {
  return { ...observation, end: sampleRuntimeResources(now) };
}

function sampleRuntimeResources(now: () => Date): RuntimeResourceSample {
  const memory = process.memoryUsage();
  return {
    sampledAt: now().toISOString(),
    rssBytes: finiteBytes(memory.rss),
    heapUsedBytes: finiteBytes(memory.heapUsed),
    externalBytes: finiteBytes(memory.external),
    arrayBuffersBytes: finiteBytes(memory.arrayBuffers),
  };
}

function finiteBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function powerOfTwoFloor(value: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}
