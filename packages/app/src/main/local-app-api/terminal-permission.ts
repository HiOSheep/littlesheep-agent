import type { PermissionPolicyId } from '@littlesheep/types'
import {
  describeToolAccess,
  resolvePermissionDecision,
} from '@littlesheep/safety'
import {
  coreSourceReadOnlyMessage,
  isReadOnlyCoreCommand,
} from '@littlesheep/tools'
import { normalizePermissionModeId } from '../modes.js'
import { HttpError } from './http.js'

export function resolveTerminalPermissionMode(value: unknown): PermissionPolicyId {
  return normalizePermissionModeId(typeof value === 'string' ? value : undefined)
}

export type TerminalOperationAuthority =
  | { source: 'workspace-user' }
  | {
      source: 'agent'
      command: string
      cwd: string
      containerRoot: string
      dataRoot?: string
      workspaceRoot?: string
      protectedRoots?: readonly string[]
      permissionMode: PermissionPolicyId
      approved: boolean
    }

/**
 * Keep user-owned interactive terminals separate from Agent execution. Opening
 * and typing in the workspace terminal is direct user control, while commands
 * submitted for an Agent still pass the Main-process boundary and mode check.
 */
export function assertTerminalOperationAllowed(options: TerminalOperationAuthority): void {
  if (options.source === 'workspace-user') return

  const descriptor = describeToolAccess(
    'exec',
    { command: options.command, cwd: options.cwd },
    {
      cwd: options.cwd,
      containerRoot: options.containerRoot,
      dataRoot: options.dataRoot ?? options.containerRoot,
      workspaceRoot: options.workspaceRoot ?? options.cwd,
      protectedRoots: options.protectedRoots,
    },
  )
  if (descriptor.resourceScope === 'protected' && !isReadOnlyCoreCommand(options.command)) {
    throw new HttpError(403, coreSourceReadOnlyMessage(descriptor.paths[0] ?? options.cwd))
  }
  const decision = resolvePermissionDecision(options.permissionMode, descriptor)
  if (decision === 'unavailable') {
    throw new HttpError(503, '当前终端操作所需的安全约束不可用。')
  }
  if (decision === 'deny') {
    throw new HttpError(403, '当前终端操作被运行时安全策略拒绝。')
  }
  if (decision === 'approval' && !options.approved) {
    throw new HttpError(403, '当前终端操作超出自动授权范围，需要用户批准。')
  }
}
