// Canonical permission-id predicates. Safety, Main and shared UI code all
// validate the same two vocabularies; keeping the truth tables here prevents
// one layer from accepting an id another layer rejects.
import type { PermissionPolicyId, PermissionPresetId } from './runtime-contracts.js'

export type LegacyPermissionModeId = PermissionPolicyId | 'info' | 'physical'

export function isPermissionPresetId(value: unknown): value is PermissionPresetId {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
}

export function isPermissionPolicyId(value: unknown): value is PermissionPolicyId {
  return value === 'full' || value === 'research' || value === 'restricted'
}

/** Legacy aliases are accepted only while reading old sessions/checkpoints. */
export function isLegacyPermissionModeId(value: unknown): value is LegacyPermissionModeId {
  return isPermissionPolicyId(value) || value === 'info' || value === 'physical'
}
