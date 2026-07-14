import type { Config } from '@littlesheep/config'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { PermissionModeId } from '../shared/permission-modes.js'
import {
  getAgentProfile,
  normalizeAgentProfileId,
  resolvePermissionModePolicy,
} from './modes.js'

export interface RunApprovalRequest {
  action: string
  detail?: unknown
  permissionMode: PermissionModeId
}

export type RunApprovalBroker = (request: RunApprovalRequest) => Promise<boolean>

export interface ResolvedRunPolicy {
  requireApprovalForAllTools: boolean
  approve: (action: string, detail?: unknown) => Promise<boolean>
  profile?: AgentProfileId
  permissionPolicyId: PermissionModeId
}

export function resolveRunPolicy(
  body: Record<string, unknown>,
  config: Config,
  approvalBroker?: RunApprovalBroker,
): ResolvedRunPolicy {
  const legacyMode = typeof body.mode === 'string' ? body.mode : undefined
  const requestedPermissionMode = typeof body.permissionMode === 'string'
    ? body.permissionMode
    : legacyMode === 'coding'
      ? undefined
      : legacyMode
  const permissionPolicy = resolvePermissionModePolicy(requestedPermissionMode)
  const requestedProfile = typeof body.profile === 'string'
    ? body.profile
    : legacyMode === 'coding'
      ? 'coding'
      : config.agents.defaults.profile
  const profile = getAgentProfile(normalizeAgentProfileId(requestedProfile))

  return {
    requireApprovalForAllTools: permissionPolicy.requireApprovalForAllTools,
    approve: createPermissionApprover(permissionPolicy.mode, approvalBroker),
    profile: profile?.id,
    permissionPolicyId: permissionPolicy.mode,
  }
}

export function createPermissionApprover(
  permissionMode: PermissionModeId,
  approvalBroker?: RunApprovalBroker,
): (action: string, detail?: unknown) => Promise<boolean> {
  if (permissionMode === 'full') return async () => true
  if (!approvalBroker) return async () => false
  return async (action, detail) => approvalBroker({ action, detail, permissionMode })
}
