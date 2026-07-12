export type PermissionModeId = 'full' | 'research' | 'restricted'
export type PermissionRisk = 'low' | 'medium' | 'critical'

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
  description: '允许读取、修改文件和执行命令；任务执行中不再逐项询问批准。',
  risk: 'critical',
  riskLabel: '最高权限',
}

export const RESEARCH_MODE: PermissionMode = {
  id: 'research',
  label: '研究',
  description: '允许读取和检索；修改文件和执行命令需要额外批准。',
  risk: 'medium',
  riskLabel: '中等权限',
}

export const RESTRICTED_MODE: PermissionMode = {
  id: 'restricted',
  label: '受限',
  description: '默认不开放任何工具权限；每个工具调用都需要用户逐项批准。',
  risk: 'low',
  riskLabel: '低权限',
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
