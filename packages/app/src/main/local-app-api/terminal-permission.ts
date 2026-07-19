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

/**
 * Enforce terminal command authorization in the Main process. The renderer's
 * confirmation is only an input; the boundary and mode are checked again here
 * immediately before a command is spawned or written to a shell session.
 */
export function assertTerminalCommandAllowed(options: {
  command: string
  cwd: string
  containerRoot: string
  permissionMode: PermissionPolicyId
  approved: boolean
}): void {
  const descriptor = describeToolAccess(
    'exec',
    { command: options.command, cwd: options.cwd },
    { cwd: options.cwd, containerRoot: options.containerRoot },
  )
  if (shouldRequestPermissionApproval(options.permissionMode, descriptor) && !options.approved) {
    throw new HttpError(403, '当前终端操作超出自动授权范围，需要用户批准。')
  }
}

/**
 * Opening a terminal starts a process immediately, so creating a session is
 * itself an execute operation. Keep it behind the same boundary/mode policy
 * instead of waiting until the first command is typed.
 */
export function assertTerminalSessionAllowed(options: {
  cwd: string
  containerRoot: string
  permissionMode: PermissionPolicyId
  approved: boolean
}): void {
  // `pwd` gives the descriptor an executable, inside-only baseline while
  // avoiding any filesystem access before the authorization decision.
  const descriptor = describeToolAccess(
    'terminal',
    { command: 'pwd', cwd: options.cwd },
    { cwd: options.cwd, containerRoot: options.containerRoot },
  )
  if (shouldRequestPermissionApproval(options.permissionMode, descriptor) && !options.approved) {
    throw new HttpError(403, '打开此工作区终端需要用户批准。')
  }
}
