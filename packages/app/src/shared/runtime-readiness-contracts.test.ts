import { describe, expect, it } from 'vitest'
import {
  isRuntimeReadiness,
  RUNTIME_READINESS_API_VERSION,
  type RuntimeReadiness,
} from './runtime-readiness-contracts.js'

function snapshot(overrides: Partial<RuntimeReadiness> = {}): RuntimeReadiness {
  return {
    state: 'starting',
    phase: 'execution',
    apiVersion: RUNTIME_READINESS_API_VERSION,
    retryable: false,
    ...overrides,
  }
}

describe('runtime readiness contract', () => {
  it('accepts the three reported states and an optional loopback port', () => {
    expect(isRuntimeReadiness(snapshot())).toBe(true)
    expect(isRuntimeReadiness(snapshot({ state: 'ready', port: 43127 }))).toBe(true)
    expect(isRuntimeReadiness(snapshot({ state: 'failed', reason: 'memory migration failed', retryable: true }))).toBe(true)
  })

  it('rejects a payload the Renderer cannot act on', () => {
    expect(isRuntimeReadiness(undefined)).toBe(false)
    expect(isRuntimeReadiness(null)).toBe(false)
    expect(isRuntimeReadiness('starting')).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), apiVersion: 2 })).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), state: 'warming-up' })).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), phase: 'unknown-stage' })).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), retryable: 'yes' })).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), reason: 42 })).toBe(false)
    // A port the renderer would fetch must be a real loopback port, never 0.
    expect(isRuntimeReadiness({ ...snapshot(), port: 0 })).toBe(false)
    expect(isRuntimeReadiness({ ...snapshot(), port: 1.5 })).toBe(false)
  })
})
