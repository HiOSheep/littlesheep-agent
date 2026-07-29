import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '@littlesheep/runner'
import {
  asSessionId,
  type RuntimeActiveRunAction,
  type RuntimeActiveRunControl,
  type RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import { RunActivityMonitor } from './run-activity-monitor.js'

function run(
  runId: string,
  startedAt: string,
  phase: RuntimeActiveRunSnapshot['phase'] = 'planning',
): RuntimeActiveRunSnapshot {
  return {
    runId,
    sessionId: asSessionId(`session-${runId}`),
    origin: 'app',
    startedAt,
    updatedAt: startedAt,
    phase,
    controlStatus: 'running',
    totalSteps: 0,
    completedSteps: 0,
    activeSteps: [],
    activeToolCount: 0,
  }
}

function controllableSource(initialRuns: RuntimeActiveRunSnapshot[]) {
  let runs = initialRuns.map(cloneRun)
  const listeners = new Set<(next: RuntimeActiveRunSnapshot[]) => void>()
  const request = vi.fn((runId: string, action: RuntimeActiveRunAction) => {
    const active = runs.find((item) => item.runId === runId)
    return active
      ? { kind: 'accepted' as const, action, run: cloneRun(active) }
      : {
        kind: 'rejected' as const,
        action,
        reason: 'run-not-active' as const,
        message: `Run is not active: ${runId}`,
      }
  })
  const control: RuntimeActiveRunControl = {
    list: () => runs.map(cloneRun),
    request,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(runs.map(cloneRun))
      return () => listeners.delete(listener)
    },
  }
  return {
    control,
    request,
    listenerCount: () => listeners.size,
    publish(next: RuntimeActiveRunSnapshot[]) {
      runs = next.map(cloneRun)
      for (const listener of [...listeners]) listener(runs.map(cloneRun))
    },
  }
}

function runnerWith(control: RuntimeActiveRunControl): AgentRunner {
  return { activeRuns: control } as AgentRunner
}

function cloneRun(value: RuntimeActiveRunSnapshot): RuntimeActiveRunSnapshot {
  return { ...value, activeSteps: value.activeSteps.map((step) => ({ ...step })) }
}

describe('RunActivityMonitor', () => {
  it('deduplicates current and retired runners, routes control, and releases old subscriptions', () => {
    const current = controllableSource([
      run('run-shared', '2026-07-29T01:00:00.000Z', 'executing'),
    ])
    const retired = controllableSource([
      run('run-old', '2026-07-29T00:59:00.000Z', 'verifying'),
      run('run-shared', '2026-07-29T01:00:00.000Z', 'finalizing'),
    ])
    const monitor = new RunActivityMonitor()
    const observed: RuntimeActiveRunSnapshot[][] = []
    const unsubscribe = monitor.subscribe((runs) => observed.push(runs))

    monitor.setRunners([
      runnerWith(current.control),
      runnerWith(current.control),
      runnerWith(retired.control),
    ])

    expect(monitor.snapshot()).toMatchObject([
      { runId: 'run-old', phase: 'verifying' },
      { runId: 'run-shared', phase: 'executing' },
    ])
    expect(current.listenerCount()).toBe(1)
    expect(retired.listenerCount()).toBe(1)
    expect(monitor.request('run-old', 'pause')).toMatchObject({ kind: 'accepted', action: 'pause' })
    expect(retired.request).toHaveBeenCalledWith('run-old', 'pause', undefined)

    monitor.setRunners([runnerWith(retired.control)])
    expect(current.listenerCount()).toBe(0)
    expect(retired.listenerCount()).toBe(1)
    current.publish([run('run-detached', '2026-07-29T01:01:00.000Z')])
    expect(monitor.snapshot().some((item) => item.runId === 'run-detached')).toBe(false)

    unsubscribe()
    expect(observed.length).toBeGreaterThan(1)
    monitor.dispose()
    expect(retired.listenerCount()).toBe(0)
    expect(monitor.snapshot()).toEqual([])
  })

  it('bounds observer retention and clears every observer on disposal', () => {
    const monitor = new RunActivityMonitor()
    const unsubscribers = Array.from({ length: 16 }, () => monitor.subscribe(() => undefined))
    expect(() => monitor.subscribe(() => undefined)).toThrow('16 listener limit')
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    expect(() => monitor.subscribe(() => undefined)).not.toThrow()
    monitor.dispose()
  })
})
