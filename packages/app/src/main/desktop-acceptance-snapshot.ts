// Acceptance-only process and runtime diagnostics. Keeping this sampler out
// of Main's bootstrap entry prevents test observability from owning lifecycle.

import type { AgentRunner } from '@littlesheep/runner'
import type { LittleSheepDesktopShell, DesktopAcceptanceSnapshot } from './desktop-shell.js'
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
    const activity = options.runActivity.diagnostics()
    return {
      ...options.desktopShell.snapshot(),
      sampledAt: new Date().toISOString(),
      process: {
        rssBytes: finiteBytes(processMemory.rss),
        heapUsedBytes: finiteBytes(processMemory.heapUsed),
        externalBytes: finiteBytes(processMemory.external),
        arrayBuffersBytes: finiteBytes(processMemory.arrayBuffers),
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
