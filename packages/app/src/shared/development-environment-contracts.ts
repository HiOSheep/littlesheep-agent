// Contracts for LS-managed development runtimes and the terminal environment.

export const DEVELOPMENT_ENVIRONMENT_IDS = [
  'node',
  'python',
  'java',
  'go',
  'rust',
  'cpp',
  'dotnet',
  'ruby',
  'php',
  'git',
  'powershell',
] as const

export type DevelopmentEnvironmentId = typeof DEVELOPMENT_ENVIRONMENT_IDS[number]

export type DevelopmentEnvironmentSource = 'builtin' | 'managed' | 'system' | 'missing'

export type DevelopmentEnvironmentState =
  | 'ready'
  | 'version-pending'
  | 'system-fallback'
  | 'missing'

export interface DevelopmentEnvironmentInfo {
  id: DevelopmentEnvironmentId
  label: string
  description: string
  category: 'runtime' | 'compiler' | 'tooling'
  source: DevelopmentEnvironmentSource
  state: DevelopmentEnvironmentState
  currentVersion: string | null
  /** The managed directory selected for the current process, when applicable. */
  activeManagedVersion: string | null
  requestedVersion: string | null
  executablePath: string | null
  managedRoot: string
  availableVersions: string[]
  terminalPathEntries: string[]
  note: string
}

export interface DevelopmentEnvironmentSnapshot {
  toolchainsRoot: string
  preferencesPath: string
  environments: DevelopmentEnvironmentInfo[]
  generatedAt: string
}

export interface DevelopmentEnvironmentPreferences {
  versions: Partial<Record<DevelopmentEnvironmentId, string>>
}

export interface DevelopmentEnvironmentPreferencePatch {
  environmentId: DevelopmentEnvironmentId
  version: string | null
}

/**
 * Version labels are also directory names under the LS data root. Keep the
 * accepted alphabet deliberately narrow so preferences cannot escape the
 * toolchain directory through path separators or dot segments.
 */
export function normalizeDevelopmentEnvironmentVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/[\u0000-\u001F]/gu, '')
  if (!normalized || normalized.length > 80) return null
  if (normalized === '.' || normalized === '..') return null
  return /^[0-9A-Za-z][0-9A-Za-z._+~-]*$/u.test(normalized) ? normalized : null
}
