// Canonical Local App API route catalog shared by server and renderer clients.

export const LOCAL_APP_API_ROUTES = {
  run: '/run',
  runStream: '/run/stream',
  runCheckpoints: '/run-checkpoints',
  projects: '/projects',
  projectRegister: '/projects/register',
  projectCreateFolder: '/projects/create-folder',
  sessions: '/sessions',
  archive: '/archive',
  state: '/state',
  runtime: '/runtime',
  readiness: '/runtime/readiness',
  webCache: '/runtime/web/cache',
  cacheQuality: '/runtime/cache-quality',
  webProviderCheck: '/runtime/web/provider-check',
  providerCalibration: '/runtime/provider-calibration',
  developmentEnvironments: '/development-environments',
  developmentEnvironmentPreferences: '/development-environments/preferences',
  developmentEnvironmentImport: '/development-environments/import',
  developmentEnvironmentRemove: '/development-environments/remove',
  dataRoot: '/data-root',
  dataRootSelect: '/data-root/select',
  dataRootMigration: '/data-root/migration',
  dataRootRollback: '/data-root/rollback',
  applicationRestart: '/application/restart',
  desktopAcceptance: '/application/acceptance',
  activeRuns: '/application/active-runs',
  activeRunsStream: '/application/active-runs/stream',
  workspaceSelect: '/workspace/select',
  attachmentSelect: '/attachments/select',
  attachmentImport: '/attachments/import',
  workspaceList: '/workspace/list',
  workspacePreview: '/workspace/preview',
  /** Metadata-only check: is the file still the version the pane is showing? */
  workspaceFileStat: '/workspace/file-stat',
  workspacePreviewServer: '/workspace/preview-server',
  workspaceReview: '/workspace/review',
  workspaceReviewDiff: '/workspace/review/diff',
  workspaceSave: '/workspace/save',
  workspaceLayout: '/workspace/layout',
  workspaceArtifacts: '/workspace/artifacts',
  workspaceOpen: '/workspace/open',
  externalOpen: '/external/open',
  workspaceOpenVscode: '/workspace/open-vscode',
  browserDiagnostics: '/browser/diagnostics',
  browserStatus: '/browser/status',
  browserClearCache: '/browser/clear-cache',
  browserClearData: '/browser/clear-data',
  terminalSession: '/workspace/terminal/session',
  /** The Shell profiles this machine can actually run (UX-29). */
  terminalShells: '/workspace/terminal/shells',
  terminalRun: '/workspace/terminal/run',
  terminalActivity: '/workspace/terminal/activity',
  terminalStream: '/workspace/terminal/stream',
  configProviders: '/config/providers',
  configApiKey: '/config/apikey',
  configWebProvider: '/config/web-provider',
  plugins: '/plugins',
  pluginsLocalCode: '/plugins/local-code',
  pluginsReload: '/plugins/reload',
  channelsStatus: '/channels/status',
  channelsReload: '/channels/reload',
  skills: '/skills',
  memoryPolicy: '/memory/policy',
  memoryFiles: '/memory/files',
  memoryTree: '/memory/tree',
  memoryEmbeddingModel: '/memory/tree/embedding-model',
  memoryMigration: '/memory/tree/migration',
  memoryRollback: '/memory/tree/rollback',
  memory: '/memory',
} as const

export const LOCAL_APP_API_PREFIXES = {
  approvals: '/approvals/',
  projects: '/projects/',
  sessions: '/sessions/',
  runs: '/runs/',
  activeRuns: '/application/active-runs/',
  runCheckpoints: '/run-checkpoints/',
  archiveSessions: '/archive/sessions/',
  archiveProjects: '/archive/projects/',
  terminalSessions: '/workspace/terminal/session/',
  plugins: '/plugins/',
  skills: '/skills/',
  memoryNodes: '/memory/tree/nodes/',
  memoryResources: '/memory/tree/resources/',
  memoryProjects: '/memory/projects/',
  memoryFiles: '/memory/files/',
  configProviders: '/config/providers/',
} as const

export function localAppApiItemPath(prefix: string, id: string, suffix = ''): string {
  return `${prefix}${encodeURIComponent(id)}${suffix}`
}

export function matchLocalAppApiItemPath(path: string, prefix: string, suffix = ''): string | null {
  if (!path.startsWith(prefix) || (suffix && !path.endsWith(suffix))) return null
  const end = suffix ? path.length - suffix.length : path.length
  const encodedId = path.slice(prefix.length, end)
  if (!encodedId || encodedId.includes('/')) return null
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return null
  }
}
