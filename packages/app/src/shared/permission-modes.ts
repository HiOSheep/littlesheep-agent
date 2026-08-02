export type PermissionModeId = 'full' | 'research' | 'restricted'
export type PermissionRisk = 'low' | 'medium' | 'critical'

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

export function resolvePermissionModePolicy(id: string | undefined): PermissionModePolicy {
  const mode = normalizePermissionModeId(id)
  return {
    mode,
    autoApprove: mode === 'full',
    requireApprovalForAllTools: mode === 'restricted',
  }
}

function migrateLegacyModeId(id: string | undefined): string | undefined {
  if (id === 'info') return 'full'
  if (id === 'physical') return 'restricted'
  if (id === 'coding') return 'research'
  return id
}
