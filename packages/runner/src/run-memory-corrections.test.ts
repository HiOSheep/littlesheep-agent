import { describe, expect, it } from 'vitest'
import { recordRunMemoryCorrection, takeRunMemoryCorrections, type RunMemoryCorrections } from './run-memory-corrections'
describe('run-owned memory correction markers', () => {
  it('keeps interleaved sessions separate and consumes each marker once', () => {
    const state: RunMemoryCorrections = {}
    recordRunMemoryCorrection(state, 'run-a', { atomId: 'a', action: 'invalidate', status: 'committed' })
    recordRunMemoryCorrection(state, 'run-b', { atomId: 'b', action: 'invalidate', status: 'committed' })
    expect(takeRunMemoryCorrections(state, 'run-a').map(item => item.atomId)).toEqual(['a'])
    expect(takeRunMemoryCorrections(state, 'run-a')).toEqual([])
    expect(takeRunMemoryCorrections(state, 'run-b').map(item => item.atomId)).toEqual(['b'])
    expect(state.memoryAtomCorrectionsByRun?.size).toBe(0)
  })
})
