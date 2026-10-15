// Run-owned derived revocation markers; the memory repository remains the durable authority.
export interface MemoryCorrection { atomId: string; action: string; status: string; revision?: number }
export interface RunMemoryCorrections { memoryAtomCorrectionsByRun?: Map<string, MemoryCorrection[]> }
export function recordRunMemoryCorrection(state: RunMemoryCorrections, runId: string, record: MemoryCorrection): void {
  if (!runId) throw new Error('memory correction requires its owning run')
  const records = state.memoryAtomCorrectionsByRun ??= new Map()
  records.set(runId, [...(records.get(runId) ?? []), record])
}
export function takeRunMemoryCorrections(state: RunMemoryCorrections, runId: string): MemoryCorrection[] {
  const records = state.memoryAtomCorrectionsByRun?.get(runId) ?? []
  state.memoryAtomCorrectionsByRun?.delete(runId)
  return records
}
