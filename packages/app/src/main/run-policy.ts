import type { Config } from '@littlesheep/config'
import type { AgentProfileId } from '@littlesheep/prompt'
import {
  describeToolAccess,
  shouldRequestPermissionApproval,
  type ContainerBoundary,
} from '@littlesheep/safety'
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
  /** Boundary calculated by Main before the renderer sees the request. */
  boundary: ContainerBoundary
}

export type RunApprovalBroker = (request: RunApprovalRequest) => Promise<boolean>

export interface RunPolicyBoundaryOptions {
  /** Active movable application-data root that defines the LS container. */
  containerRoot?: string
  /** Run cwd used when a tool detail contains a relative path. */
  cwd?: string
}

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
  boundaryOptions: RunPolicyBoundaryOptions = {},
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
    approve: createPermissionApprover(permissionPolicy.mode, approvalBroker, boundaryOptions),
    profile: profile?.id,
    permissionPolicyId: permissionPolicy.mode,
  }
}

export function createPermissionApprover(
  permissionMode: PermissionModeId,
  approvalBroker?: RunApprovalBroker,
  boundaryOptions: RunPolicyBoundaryOptions = {},
): (action: string, detail?: unknown) => Promise<boolean> {
  const containerRoot = boundaryOptions.containerRoot
  const cwd = boundaryOptions.cwd ?? containerRoot ?? process.cwd()
  return async (action, detail) => {
    const descriptor = describeToolAccess(action, detail, { cwd, containerRoot })
    if (!shouldRequestPermissionApproval(permissionMode, descriptor)) return true
    if (!approvalBroker) return false
    return approvalBroker({ action, detail, permissionMode, boundary: descriptor.boundary })
  }
}
