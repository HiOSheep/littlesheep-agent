import type { PermissionConstraintAvailability, PermissionPresetId } from '@littlesheep/types'

export type { ApprovalPolicyId } from '@littlesheep/types'

export type PermissionModeId = 'full' | 'research' | 'restricted'
/** Values that may be explicitly persisted for a session during the V2 transition. */
export type PermissionSelectionId = PermissionModeId | 'read-only' | 'workspace-write'
export type PermissionRisk = 'low' | 'medium' | 'critical'

export interface PermissionPresetV2 {
  id: PermissionPresetId
  label: string
  description: string
  risk: PermissionRisk
}

/** Permission V2 access presets. The legacy mode contract below remains readable. */
export const PERMISSION_PRESETS_V2: readonly PermissionPresetV2[] = [
  {
    id: 'read-only',
    label: '只读',
    description: '允许工作区内可证明安全的读取；写入需要明确升级权限。',
    risk: 'low',
  },
  {
    id: 'workspace-write',
    label: '工作区写入',
    description: '工作区内普通文件操作可在可靠执行约束生效后自动进行。',
    risk: 'medium',
  },
  {
    id: 'full-access',
    label: '完全访问',
    description: '经用户明确确认后放宽本地资源范围；强制审批和硬拒绝仍然生效。',
    risk: 'critical',
  },
]

export const SELECTABLE_PERMISSION_PRESETS_V2 = PERMISSION_PRESETS_V2.filter(
  (preset): preset is PermissionPresetV2 & { id: 'read-only' | 'workspace-write' } => (
    preset.id === 'read-only' || preset.id === 'workspace-write'
  ),
)

/** New sessions may select workspace-write only after its enforcement is active. */
export function resolveFutureDefaultPermissionPreset(input: {
  workspaceFileWrites: PermissionConstraintAvailability
}): PermissionPresetId | undefined {
  return input.workspaceFileWrites === 'available' ? 'workspace-write' : undefined
}

/**
 * Authorization policy only. General/coding behavior profiles live in the
 * prompt package and must never be inferred from this type.
 */
export interface PermissionMode {
  id: PermissionModeId
  label: string
  description: string
  risk: PermissionRisk
  riskLabel: string
}

export const FULL_ACCESS_MODE: PermissionMode = {
  id: 'full',
  label: '完全访问',
  description: '确认风险后，LS 可直接读取、修改、删除和执行容器内外资源，不再逐次请求批准。',
  risk: 'critical',
  riskLabel: '最高权限',
}

export const RESEARCH_MODE: PermissionMode = {
  id: 'research',
  label: '研究',
  description: 'LS 容器内默认只能查看；修改、删除、执行及访问容器外资源都需批准。',
  risk: 'medium',
  riskLabel: '中等权限',
}

export const RESTRICTED_MODE: PermissionMode = {
  id: 'restricted',
  label: '受限',
  description: '所有工具操作都需用户批准，包括 LS 容器内的查看。',
  risk: 'low',
  riskLabel: '最低权限',
}

export const ALL_PERMISSION_MODES: PermissionMode[] = [
  FULL_ACCESS_MODE,
  RESEARCH_MODE,
  RESTRICTED_MODE,
]

export const DEFAULT_PERMISSION_MODE: PermissionMode = RESEARCH_MODE

export interface PermissionModePolicy {
  mode: PermissionModeId
  autoApprove: boolean
  requireApprovalForAllTools: boolean
}

export function getPermissionMode(id: string | undefined): PermissionMode | undefined {
  if (!id) return undefined
  return ALL_PERMISSION_MODES.find((mode) => mode.id === id)
}

export function normalizePermissionModeId(id: string | undefined): PermissionModeId {
  const migrated = migrateLegacyModeId(id)
  return getPermissionMode(migrated)?.id ?? DEFAULT_PERMISSION_MODE.id
}

/**
 * Preserve the two V2 presets that can currently be explicitly selected while
 * keeping old aliases on their established legacy path. In particular,
 * `full-access` remains the historical alias for legacy `full` here; the V2
 * full-access preset needs its own confirmed, Main-owned activation path.
 */
export function normalizePermissionSelectionId(id: string | undefined): PermissionSelectionId {
  if (id === 'read-only' || id === 'workspace-write') return id
  return normalizePermissionModeId(id)
}

export function isPermissionSelectionPreset(
  value: unknown,
): value is Extract<PermissionSelectionId, 'read-only' | 'workspace-write'> {
  return value === 'read-only' || value === 'workspace-write'
}

export function resolvePermissionModePolicy(id: string | undefined): PermissionModePolicy {
  const mode = normalizePermissionModeId(id)
  return {
    mode,
    autoApprove: mode === 'full',
    requireApprovalForAllTools: mode === 'restricted',
  }
}

function migrateLegacyModeId(id: string | undefined): string | undefined {
  if (id === 'full-access') return 'full'
  if (id === 'info') return 'full'
  if (id === 'physical') return 'restricted'
  if (id === 'coding') return 'research'
  return id
}
