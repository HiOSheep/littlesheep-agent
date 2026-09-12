import type { Config } from '@littlesheep/config'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { NetworkReadPolicy } from '@littlesheep/types'
import { resolveNetworkReadPolicy } from '@littlesheep/runner'
import {
  describeToolAccess,
  resolvePermissionDecision,
  type ContainerBoundary,
} from '@littlesheep/safety'
import type { PermissionModeId } from '../shared/permission-modes.js'
import { normalizePermissionModeId } from '../shared/permission-modes.js'
import type { SessionIndex } from './session-index.js'
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
  /** Resolved network policy used for the Main-process recheck of web input. */
  networkPolicy?: Readonly<NetworkReadPolicy>
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
  const networkPolicy = boundaryOptions.networkPolicy ?? resolveNetworkReadPolicy(config)

  return {
    requireApprovalForAllTools: permissionPolicy.requireApprovalForAllTools,
    approve: createPermissionApprover(permissionPolicy.mode, approvalBroker, {
      ...boundaryOptions,
      networkPolicy,
    }),
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
  const networkPolicy = boundaryOptions.networkPolicy
  return async (action, detail) => {
    const descriptor = describeToolAccess(action, detail, { cwd, containerRoot, networkPolicy })
    const decision = resolvePermissionDecision(permissionMode, descriptor, {
      strictReadApproval: networkPolicy?.strictReadApproval === true,
    })
    if (decision === 'deny') return false
    if (decision === 'allow') return true
    if (!approvalBroker) return false
    return approvalBroker({ action, detail, permissionMode, boundary: descriptor.boundary })
  }
}

/** Startup has no interactive approval broker. Reads needing approval remain unknown. */
export function createRecoveryReadAuthorizer(
  getSessionIndex: () => Pick<SessionIndex, 'list'> | null,
  containerRoot: string,
): (path: string, identity: { sessionId: string; runId: string }) => Promise<boolean> {
  return async (path, identity) => {
    const session = (await getSessionIndex()?.list())?.find((item) => item.id === identity.sessionId)
    if (!session) return false
    return createPermissionApprover(normalizePermissionModeId(session.mode), undefined, {
      containerRoot, cwd: containerRoot,
    })('read', { file_path: path })
  }
}
