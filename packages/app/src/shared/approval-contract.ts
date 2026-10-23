// One wire contract for a Main-owned approval request. Main builds it, the
// Local App API serializes it and the renderer consumes it; previously the
// fields were declared three times with different optionality.
import type { PermissionPresetId, ShellApprovalBatch } from '@littlesheep/types'
import type { ContainerBoundary } from '@littlesheep/safety'
import type { PermissionModeId } from './permission-modes.js'

export interface ApprovalRequestFields {
  action: string
  detail?: unknown
  permissionMode: PermissionModeId
  permissionPreset?: PermissionPresetId
  /** Boundary calculated by Main before the renderer sees the request. */
  boundary?: ContainerBoundary
  /** A Main-owned forced approval; full access cannot auto-confirm it. */
  requiresExplicitUserApproval?: boolean
  shellBatch?: ShellApprovalBatch
  /** Set only from Main's fixed Shell candidate check, never from request JSON. */
  rememberShellCommandAvailable?: boolean
}

/** Main-side request: the boundary is always computed before publication. */
export interface RunApprovalRequest extends ApprovalRequestFields {
  boundary: ContainerBoundary
}

/** Serialized SSE/HTTP approval request. */
export interface ApprovalRequest extends ApprovalRequestFields {
  id: string
  source: 'agent' | 'workspace'
}
