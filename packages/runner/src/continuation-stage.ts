import type { ClarificationRequest, RunCheckpoint, StageName } from '@littlesheep/types'

/** Resolve the semantic continuation target; FINALIZE is only a storage boundary. */
export function resolveSemanticResumeStage(
  checkpoint: RunCheckpoint,
  clarificationSource?: ClarificationRequest['sourceStage'],
): StageName {
  if (checkpoint.status === 'waiting_user') {
    if (clarificationSource === 'classify' || clarificationSource === 'decide') return 'decide'
    if (clarificationSource === 'execute' || clarificationSource === 'recover') return 'recover'
    if (clarificationSource === 'verify') return 'decide'
    throw new Error('waiting-user checkpoint has no semantic clarification source stage')
  }
  if (checkpoint.currentStage === 'enter') return 'classify'
  if (checkpoint.currentStage !== 'finalize') return checkpoint.currentStage
  if (checkpoint.resumeState?.lastError) return 'recover'
  const incomplete = checkpoint.taskBook?.steps.some((step) => (step.status ?? 'pending') !== 'done')
  if (incomplete) return checkpoint.taskExecution ? 'execute' : 'decide'
  return 'reply'
}
