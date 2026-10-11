import { realpathSync, statSync } from 'node:fs'
import type { Config } from '@littlesheep/config'
import type { AgentProfileId } from '@littlesheep/prompt'
import type {
  NetworkReadPolicy,
  PermissionPolicyV2Snapshot,
  PermissionPresetId,
} from '@littlesheep/types'
import { resolveNetworkReadPolicy } from '@littlesheep/runner'
import { WORKSPACE_FILE_GUARD_AVAILABLE } from '@littlesheep/tools'
import {
  describeToolAccess,
  resolvePermissionDecision,
  type ContainerBoundary,
} from '@littlesheep/safety'
import type { PermissionModeId, PermissionSelectionId } from '../shared/permission-modes.js'
import { isPermissionSelectionPreset, normalizePermissionSelectionId } from '../shared/permission-modes.js'
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
  permissionPreset?: PermissionPresetId
  /** Boundary calculated by Main before the renderer sees the request. */
  boundary: ContainerBoundary
  /** A Main-owned forced approval; full access cannot auto-confirm it. */
  requiresExplicitUserApproval?: boolean
}

export type RunApprovalBroker = (request: RunApprovalRequest) => Promise<boolean>

export interface RunPolicyBoundaryOptions {
  /** Legacy logical-container root retained for legacy mode behavior. */
  containerRoot?: string
  /** Active movable application data; it is not an authorized user workspace. */
  dataRoot?: string
  /** Main-resolved workspace root for this run or checkpoint. */
  workspaceRoot?: string
  /** Host-owned source roots that remain read-only in every mode. */
  protectedRoots?: readonly string[]
  /** Run cwd used when a tool detail contains a relative path. */
  cwd?: string
  /** Resolved network policy used for the Main-process recheck of web input. */
  networkPolicy?: Readonly<NetworkReadPolicy>
  /** Capability is available only when the native tool path guard is wired. */
  workspaceFileWrites?: 'available' | 'unavailable'
  /** V2 confirmation is a Main-owned fact; request bodies cannot set it. */
  fullAccessConfirmed?: boolean
  permissionPolicyV2?: PermissionPolicyV2Snapshot
}

export interface ResolvedRunPolicy {
  requireApprovalForAllTools: boolean
  approve: (
    action: string,
    detail?: unknown,
    approvalOptions?: { requiresExplicitUserApproval?: boolean },
  ) => Promise<boolean>
  profile?: AgentProfileId
  permissionPolicyId: PermissionModeId
  permissionPreset?: PermissionPresetId
  permissionPolicyV2?: PermissionPolicyV2Snapshot
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
  const requestedPreset = isPermissionSelectionPreset(body.permissionPreset)
    ? body.permissionPreset
    : body.permissionPreset === 'full-access' ? 'full-access' : undefined
  const permissionPolicy = resolvePermissionModePolicy(requestedPreset ? 'research' : requestedPermissionMode)
  const requestedProfile = typeof body.profile === 'string'
    ? body.profile
    : legacyMode === 'coding'
      ? 'coding'
      : config.agents.defaults.profile
  const profile = getAgentProfile(normalizeAgentProfileId(requestedProfile))
  const networkPolicy = boundaryOptions.networkPolicy ?? resolveNetworkReadPolicy(config)
  const workspaceRoot = resolveExistingDirectory(boundaryOptions.workspaceRoot)
  const permissionPolicyV2 = requestedPreset
    ? buildPermissionPolicySnapshot(requestedPreset, boundaryOptions, workspaceRoot)
    : undefined
  const selectedPolicy = permissionPolicyV2?.preset ?? permissionPolicy.mode

  return {
    requireApprovalForAllTools: permissionPolicy.requireApprovalForAllTools,
    approve: createPermissionApprover(selectedPolicy, approvalBroker, {
      ...boundaryOptions,
      networkPolicy,
      ...(permissionPolicyV2 ? { permissionPolicyV2 } : {}),
    }),
    profile: profile?.id,
    permissionPolicyId: permissionPolicy.mode,
    ...(permissionPolicyV2 ? {
      permissionPreset: permissionPolicyV2.preset,
      permissionPolicyV2,
    } : {}),
  }
}

export function createPermissionApprover(
  permissionMode: PermissionSelectionId | PermissionPresetId,
  approvalBroker?: RunApprovalBroker,
  boundaryOptions: RunPolicyBoundaryOptions = {},
): (
  action: string,
  detail?: unknown,
  approvalOptions?: { requiresExplicitUserApproval?: boolean },
) => Promise<boolean> {
  const containerRoot = boundaryOptions.containerRoot
  const cwd = boundaryOptions.cwd ?? containerRoot ?? process.cwd()
  const networkPolicy = boundaryOptions.networkPolicy
  return async (action, detail, approvalOptions) => {
    const descriptor = describeToolAccess(action, detail, {
      cwd,
      containerRoot,
      dataRoot: boundaryOptions.dataRoot ?? containerRoot,
      workspaceRoot: boundaryOptions.workspaceRoot ?? cwd,
      protectedRoots: boundaryOptions.protectedRoots,
      networkPolicy,
      permissionPolicyV2: boundaryOptions.permissionPolicyV2,
    })
    let decision = resolvePermissionDecision(permissionMode, descriptor, {
      strictReadApproval: networkPolicy?.strictReadApproval === true,
      approvalPolicy: boundaryOptions.permissionPolicyV2?.approvalPolicy,
      workspaceFileWrites: boundaryOptions.permissionPolicyV2?.constraints.workspaceFileWrites
        ?? boundaryOptions.workspaceFileWrites,
      shellIsolation: boundaryOptions.permissionPolicyV2?.constraints.shellIsolation,
      fullAccessConfirmed: boundaryOptions.permissionPolicyV2?.fullAccessConfirmed
        ?? boundaryOptions.fullAccessConfirmed,
    })
    if (approvalOptions?.requiresExplicitUserApproval === true && decision === 'allow') {
      decision = boundaryOptions.permissionPolicyV2?.approvalPolicy === 'deny'
        ? 'deny'
        : 'approval'
    }
    if (decision === 'deny' || decision === 'unavailable') return false
    if (decision === 'allow') return true
    if (!approvalBroker) return false
    return approvalBroker({
      action,
      detail,
      permissionMode: isLegacyPermissionMode(permissionMode) ? permissionMode : 'research',
      ...(isPermissionPresetId(permissionMode) ? { permissionPreset: permissionMode } : {}),
      boundary: descriptor.boundary,
      ...(approvalOptions?.requiresExplicitUserApproval === true || descriptor.hardDecision === 'approval'
        ? { requiresExplicitUserApproval: true }
        : {}),
    })
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
    const selection = normalizePermissionSelectionId(session.mode)
    // The startup reconciler only receives a boolean, then reads by path. It
    // cannot hold the native directory lease through that read. Do not grant
    // V2 workspace auto-read to this unguarded entry; retain unknown outcome.
    if (isPermissionSelectionPreset(selection)) return false
    return createPermissionApprover(selection, undefined, {
      containerRoot,
      dataRoot: containerRoot,
      workspaceRoot: session.workspacePath,
      cwd: session.workspacePath ?? containerRoot,
    })('read', { file_path: path })
  }
}

function buildPermissionPolicySnapshot(
  preset: PermissionPresetId,
  boundaryOptions: RunPolicyBoundaryOptions,
  workspaceRoot: string | undefined,
): PermissionPolicyV2Snapshot {
  const dataRoot = resolveExistingDirectory(boundaryOptions.dataRoot ?? boundaryOptions.containerRoot)
  const workspaceFileWrites = preset === 'workspace-write'
    && WORKSPACE_FILE_GUARD_AVAILABLE
    && boundaryOptions.workspaceFileWrites !== 'unavailable'
    && workspaceRoot
    ? 'available'
    : 'unavailable'
  return Object.freeze({
    version: 2,
    preset,
    approvalPolicy: 'prompt',
    ...(dataRoot ? { dataRoot } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    protectedRoots: Object.freeze((boundaryOptions.protectedRoots ?? []).map(
      (path) => resolveExistingDirectory(path) ?? path,
    )),
    constraints: Object.freeze({
      workspaceFileWrites,
      shellIsolation: 'unavailable',
    }),
    fullAccessConfirmed: preset === 'full-access' && boundaryOptions.fullAccessConfirmed === true,
  })
}

function resolveExistingDirectory(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    if (!statSync(path).isDirectory()) return undefined
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function isPermissionPresetId(value: PermissionSelectionId | PermissionPresetId): value is PermissionPresetId {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
}

function isLegacyPermissionMode(value: PermissionSelectionId | PermissionPresetId): value is PermissionModeId {
  return value === 'full' || value === 'research' || value === 'restricted'
}
