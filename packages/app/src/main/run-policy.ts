// Resolves the Main-owned tool policy and binds per-run Shell authorization facts.
import { realpathSync, statSync } from 'node:fs'
import type { Config } from '@littlesheep/config'
import type { AgentProfileId } from '@littlesheep/prompt'
import type {
  NetworkReadPolicy,
  PermissionPolicyV2Snapshot,
  PermissionPresetId,
  ShellExecutionDescription,
} from '@littlesheep/types'
import { resolveNetworkReadPolicy } from '@littlesheep/runner'
import { WORKSPACE_FILE_GUARD_AVAILABLE, bindShellApprovalAuthority } from '@littlesheep/tools'
import type { ShellApprovalResult } from '@littlesheep/tools'
import type { ShellApprovalBatch } from '@littlesheep/types'
import {
  describeToolAccess,
  resolvePermissionDecision,
  type ContainerBoundary,
} from '@littlesheep/safety'
import type { PermissionModeId } from '../shared/permission-modes.js'
import { isPermissionSelectionPreset, normalizePermissionSelectionId } from '../shared/permission-modes.js'
import type { SessionIndex } from './session-index.js'
import { isRepeatCandidate } from './shell-repeat-authorization-store.js'
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
  shellBatch?: ShellApprovalBatch
  /** Set only from Main's fixed Shell candidate check, never from request JSON. */
  rememberShellCommandAvailable?: boolean
}

export type RunApprovalBroker = (request: RunApprovalRequest) => Promise<ShellApprovalResult>

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
  /** Process-local Shell authority scope, assembled by Main; never accepted from request JSON. */
  shellScope?: { runId: string; sessionId?: string; workspaceId?: string; signal?: AbortSignal; current(): Promise<string> }
  /** Main-owned repeat state. A renderer request can never provide this callback. */
  shellRepeatAuthorization?: {
    consume(description: ShellExecutionDescription): boolean
    remember?(description: ShellExecutionDescription): (() => void) | undefined
  }
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
    : undefined
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

  const approve = createPermissionApprover(selectedPolicy, approvalBroker, {
    ...boundaryOptions, networkPolicy, ...(permissionPolicyV2 ? { permissionPolicyV2 } : {}),
  })
  const permissionFacts = { selectedPolicy, permissionPolicyV2, protectedRoots: boundaryOptions.protectedRoots,
    networkPolicy, fullAccessConfirmed: boundaryOptions.fullAccessConfirmed }
  bindShellApprovalAuthority(approve, {
    ...boundaryOptions.shellScope,
    workspaceRoot: workspaceRoot ?? boundaryOptions.cwd ?? process.cwd(),
    permission: permissionFacts,
    current: boundaryOptions.shellScope?.current ?? (async () => JSON.stringify(permissionFacts)),
    decide: (input) => {
      const descriptor = describeToolAccess('exec', input, {
        ...boundaryOptions, cwd: boundaryOptions.cwd ?? workspaceRoot ?? process.cwd(), networkPolicy,
        permissionPolicyV2,
      })
      return resolvePermissionDecision(selectedPolicy, descriptor, {
        approvalPolicy: permissionPolicyV2?.approvalPolicy,
        shellIsolation: permissionPolicyV2?.constraints.shellIsolation,
        fullAccessConfirmed: permissionPolicyV2?.fullAccessConfirmed ?? boundaryOptions.fullAccessConfirmed,
      })
    },
    consumeRepeatAuthorization: (description) => {
      const descriptor = describeToolAccess('exec', { command: description.command, cwd: description.cwd.path }, {
        ...boundaryOptions, cwd: boundaryOptions.cwd ?? workspaceRoot ?? process.cwd(), networkPolicy,
        permissionPolicyV2,
      })
      // Main-forced approval and an approval-deny policy remain above the
      // conversation repeat exception. The store itself accepts only its fixed
      // reviewed command candidate and exact execution binding.
      if (descriptor.hardDecision !== 'allow' || permissionPolicyV2?.approvalPolicy === 'deny') return false
      return boundaryOptions.shellRepeatAuthorization?.consume(description) === true
    },
    rememberRepeatAuthorization: (description) => {
      const descriptor = describeToolAccess('exec', { command: description.command, cwd: description.cwd.path }, {
        ...boundaryOptions, cwd: boundaryOptions.cwd ?? workspaceRoot ?? process.cwd(), networkPolicy,
        permissionPolicyV2,
      })
      if (descriptor.hardDecision !== 'allow' || permissionPolicyV2?.approvalPolicy === 'deny') return undefined
      return boundaryOptions.shellRepeatAuthorization?.remember?.(description)
    },
    request: async (shellBatch) => approvalBroker ? approvalBroker({ action: 'exec', detail: shellBatch,
      shellBatch, permissionMode: isLegacyPermissionMode(selectedPolicy) ? selectedPolicy : 'research',
      ...(isPermissionPresetId(selectedPolicy) ? { permissionPreset: selectedPolicy } : {}),
      boundary: 'unknown', requiresExplicitUserApproval: true,
      ...(canOfferShellRepeat(shellBatch, boundaryOptions, networkPolicy, permissionPolicyV2, workspaceRoot)
        ? { rememberShellCommandAvailable: true } : {}),
    }) : false,
  })
  return {
    requireApprovalForAllTools: permissionPolicy.requireApprovalForAllTools,
    approve,
    profile: profile?.id,
    permissionPolicyId: permissionPolicy.mode,
    ...(permissionPolicyV2 ? {
      permissionPreset: permissionPolicyV2.preset,
      permissionPolicyV2,
    } : {}),
  }
}

function canOfferShellRepeat(
  batch: ShellApprovalBatch,
  boundaryOptions: RunPolicyBoundaryOptions,
  networkPolicy: NetworkReadPolicy,
  permissionPolicyV2: PermissionPolicyV2Snapshot | undefined,
  workspaceRoot: string | undefined,
): boolean {
  const command = batch.scope === 'once' && batch.commands.length === 1 ? batch.commands[0] : undefined
  if (!command || !permissionPolicyV2 || permissionPolicyV2.approvalPolicy === 'deny'
    || !isRepeatCandidate(command)) return false
  const descriptor = describeToolAccess('exec', { command: command.command, cwd: command.cwd.path }, {
    ...boundaryOptions, cwd: boundaryOptions.cwd ?? workspaceRoot ?? process.cwd(), networkPolicy,
    permissionPolicyV2,
  })
  return descriptor.hardDecision === 'allow'
}

export function createPermissionApprover(
  permissionMode: PermissionModeId | PermissionPresetId,
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
    if (decision === 'approval' && boundaryOptions.permissionPolicyV2?.approvalPolicy === 'deny') return false
    if (decision === 'deny' || decision === 'unavailable') return false
    if (decision === 'allow') return true
    if (!approvalBroker) return false
    const approval = await approvalBroker({
      action,
      detail,
      permissionMode: isLegacyPermissionMode(permissionMode) ? permissionMode : 'research',
      ...(isPermissionPresetId(permissionMode) ? { permissionPreset: permissionMode } : {}),
      boundary: descriptor.boundary,
      ...(approvalOptions?.requiresExplicitUserApproval === true || descriptor.hardDecision === 'approval'
        ? { requiresExplicitUserApproval: true }
        : {}),
    })
    return approval === true || (typeof approval === 'object' && approval.approved === true)
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

function isPermissionPresetId(value: PermissionModeId | PermissionPresetId): value is PermissionPresetId {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
}

function isLegacyPermissionMode(value: PermissionModeId | PermissionPresetId): value is PermissionModeId {
  return value === 'full' || value === 'research' || value === 'restricted'
}
