// Acceptance-only process and runtime diagnostics. Keeping this sampler out
// of Main's bootstrap entry prevents test observability from owning lifecycle.

import type { AgentRunner } from '@littlesheep/runner'
import { app } from 'electron'
import type {
  DesktopAcceptanceResourceType,
  LittleSheepDesktopShell,
  DesktopAcceptanceSnapshot,
} from './desktop-shell.js'
import type { RunActivityMonitor } from './run-activity-monitor.js'

interface DesktopAcceptanceSnapshotOptions {
  desktopShell: LittleSheepDesktopShell
  runActivity: RunActivityMonitor
  getCurrentRunner: () => AgentRunner | null
  getRetiredRunnerCount: () => number
}

export function createDesktopAcceptanceSnapshotProvider(
  options: DesktopAcceptanceSnapshotOptions,
): () => DesktopAcceptanceSnapshot {
  return () => {
    const processMemory = process.memoryUsage()
    const diagnostics = process as typeof process & {
      _getActiveHandles?: () => unknown[]
      _getActiveRequests?: () => unknown[]
    }
    const activity = options.runActivity.diagnostics()
    const electronMetrics = app.getAppMetrics()
    const activeHandles = diagnostics._getActiveHandles?.()
    const activeRequests = diagnostics._getActiveRequests?.()
    return {
      ...options.desktopShell.snapshot(),
      sampledAt: new Date().toISOString(),
      process: {
        rssBytes: finiteBytes(processMemory.rss),
        heapUsedBytes: finiteBytes(processMemory.heapUsed),
        externalBytes: finiteBytes(processMemory.external),
        arrayBuffersBytes: finiteBytes(processMemory.arrayBuffers),
        activeHandleCount: boundedCount(activeHandles),
        activeRequestCount: boundedCount(activeRequests),
        activeHandleTypes: boundedResourceTypes(activeHandles),
        activeRequestTypes: boundedResourceTypes(activeRequests),
      },
      electron: {
        processCount: electronMetrics.length,
        workingSetBytes: sumMetricBytes(electronMetrics, 'workingSetSize'),
        peakWorkingSetBytes: sumMetricBytes(electronMetrics, 'peakWorkingSetSize'),
        privateBytes: sumMetricBytes(electronMetrics, 'privateBytes'),
      },
      runtime: {
        currentRunnerActiveRunCount: activeRunnerCount(options.getCurrentRunner()),
        aggregatedActiveRunCount: activity.activeRunCount,
        retiredRunnerCount: options.getRetiredRunnerCount(),
        activitySourceCount: activity.sourceCount,
        activityListenerCount: activity.listenerCount,
      },
    }
  }
}

function activeRunnerCount(runner: AgentRunner | null): number {
  try {
    return runner?.activeRuns?.list().length ?? 0
  } catch {
    return 0
  }
}

function finiteBytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function boundedCount(value: unknown[] | undefined): number {
  return Array.isArray(value) ? Math.min(100_000, value.length) : 0
}

function boundedResourceTypes(value: unknown[] | undefined): DesktopAcceptanceResourceType[] {
  if (!Array.isArray(value)) return []
  const counts = new Map<string, number>()
  for (const resource of value.slice(0, 100_000)) {
    const rawName = resource && (typeof resource === 'object' || typeof resource === 'function')
      ? (resource as { constructor?: { name?: unknown } }).constructor?.name
      : undefined
    const normalized = typeof rawName === 'string'
      ? rawName.replace(/[^A-Za-z0-9_$.-]/gu, '').slice(0, 80)
      : ''
    const type = normalized || 'Unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
    .slice(0, 16)
}

function sumMetricBytes(
  metrics: ReturnType<typeof app.getAppMetrics>,
  key: 'workingSetSize' | 'peakWorkingSetSize' | 'privateBytes',
): number {
  return metrics.reduce((total, metric) => {
    const kibibytes = metric.memory?.[key]
    return total + (typeof kibibytes === 'number' && Number.isFinite(kibibytes)
      ? Math.max(0, Math.floor(kibibytes * 1024))
      : 0)
  }, 0)
}
