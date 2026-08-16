import type { PermissionPolicyId } from '@littlesheep/types'
import {
  describeToolAccess,
  shouldRequestPermissionApproval,
} from '@littlesheep/safety'
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
    { cwd: options.cwd, containerRoot: options.containerRoot },
  )
  if (shouldRequestPermissionApproval(options.permissionMode, descriptor) && !options.approved) {
    throw new HttpError(403, '当前终端操作超出自动授权范围，需要用户批准。')
  }
}
