// The renderer declares the capability defaults locally (importing config's values
// would break the renderer build), so the two copies are compared here. A drift would
// mean the editor promises "默认 256K" while the runtime applies something else —
// silently, and only visible as wrong compaction behaviour at run time.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL_REASONING_OPTIONS,
  RUNTIME_REASONINGS,
} from '@littlesheep/config'
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatTokenBudget,
} from './model-capability-defaults'

describe('model capability defaults', () => {
  it('matches the constants the runtime actually applies', () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(DEFAULT_MODEL_CONTEXT_WINDOW)
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(DEFAULT_MODEL_MAX_OUTPUT_TOKENS)
  })

  it('defaults reasoning to every runtime level', () => {
    // The user expressed no preference, so nothing may be hidden from the picker.
    expect([...DEFAULT_MODEL_REASONING_OPTIONS]).toEqual([...RUNTIME_REASONINGS])
  })

  it('states the requested budget in the units the editor shows', () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(256_000)
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(32_000)
    expect(formatTokenBudget(DEFAULT_CONTEXT_WINDOW_TOKENS)).toBe('256K')
    expect(formatTokenBudget(DEFAULT_MAX_OUTPUT_TOKENS)).toBe('32K')
  })

  it('formats other budgets without inventing precision', () => {
    expect(formatTokenBudget(1_000_000)).toBe('1M')
    expect(formatTokenBudget(999)).toBe('999')
  })
})
