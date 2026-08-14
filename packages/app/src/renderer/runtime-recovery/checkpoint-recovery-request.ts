import type { AgentProfileId } from '@littlesheep/prompt'
import type { RuntimeReasoning } from '../../shared/model-capabilities'
import type { PermissionModeId } from '../../shared/permission-modes'

export interface CheckpointRecoveryTurnIdentity {
  fingerprint: string
  requestKey: string
}

export interface CheckpointRecoveryTurnInput {
  checkpointId: string
  text: string
  permissionMode: PermissionModeId
  reasoning?: RuntimeReasoning
  profile?: AgentProfileId
}

export function resolveCheckpointRecoveryTurnIdentity(
  current: CheckpointRecoveryTurnIdentity | null,
  input: CheckpointRecoveryTurnInput,
  createRequestKey: () => string = () => crypto.randomUUID(),
): CheckpointRecoveryTurnIdentity {
  const fingerprint = JSON.stringify({
    checkpointId: input.checkpointId,
    text: input.text,
    permissionMode: input.permissionMode,
    reasoning: input.reasoning ?? null,
    profile: input.profile ?? null,
  })
  if (current?.fingerprint === fingerprint) return current
  return { fingerprint, requestKey: createRequestKey() }
}
