import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceMonacoModelRegistry,
  MAX_WORKSPACE_MONACO_MODEL_BYTES,
  MAX_WORKSPACE_MONACO_MODELS,
  type WorkspaceMonacoTextModel,
} from './monaco-model-cache'

describe('workspace Monaco model registry', () => {
  it('keeps active models and evicts the oldest idle model by entry count', () => {
    const registry = createWorkspaceMonacoModelRegistry({ maxEntries: 2, maxBytes: 1_000_000 })
    const first = model('first', 10)
    const second = model('second', 10)
    const third = model('third', 10)
    const releaseFirst = registry.acquire(first)
    const releaseSecond = registry.acquire(second)
    releaseFirst()
    registry.acquire(third)

    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).not.toHaveBeenCalled()
    expect(third.dispose).not.toHaveBeenCalled()
    releaseSecond()
  })

  it('evicts idle content by estimated byte budget and drops its view state', () => {
    const registry = createWorkspaceMonacoModelRegistry({ maxEntries: 10, maxBytes: 1_100 })
    const first = model('first', 20)
    const second = model('second', 20)
    const releaseFirst = registry.acquire(first)
    registry.saveViewState('inmemory://first', { line: 7 })
    releaseFirst()
    registry.acquire(second)

    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(registry.readViewState('inmemory://first')).toBeUndefined()
  })

  it('keeps a bounded view state for a reusable model', () => {
    const registry = createWorkspaceMonacoModelRegistry()
    const reusable = model('reusable', 10)
    const release = registry.acquire(reusable)
    registry.saveViewState('inmemory://reusable', { scrollTop: 120 })
    release()

    expect(registry.readViewState('inmemory://reusable')).toEqual({ scrollTop: 120 })
    expect(MAX_WORKSPACE_MONACO_MODELS).toBe(40)
    expect(MAX_WORKSPACE_MONACO_MODEL_BYTES).toBe(20 * 1024 * 1024)
  })

  it('does not let a retired model replace a newer model with the same URI', () => {
    const registry = createWorkspaceMonacoModelRegistry({ maxEntries: 2, maxBytes: 1_000_000 })
    const first = model('shared', 10)
    const replacement = model('shared', 20)
    const releaseFirst = registry.acquire(first)
    registry.saveViewState('inmemory://shared', { generation: 'first' })
    const releaseReplacement = registry.acquire(replacement)
    registry.saveViewState('inmemory://shared', { generation: 'replacement' })

    releaseFirst()

    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(replacement.dispose).not.toHaveBeenCalled()
    expect(registry.readViewState('inmemory://shared')).toEqual({ generation: 'replacement' })
    releaseReplacement()
  })
})

function model(name: string, length: number): WorkspaceMonacoTextModel {
  let disposed = false
  const dispose = vi.fn(() => { disposed = true })
  return {
    dispose,
    getValueLength: () => length,
    isDisposed: () => disposed,
    uri: { toString: () => `inmemory://${name}` },
  }
}
