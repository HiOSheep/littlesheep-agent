// Canonical Local App API route catalog shared by server and renderer clients.

export const LOCAL_APP_API_ROUTES = {
  run: '/run',
  runStream: '/run/stream',
  projects: '/projects',
  projectRegister: '/projects/register',
  projectCreateFolder: '/projects/create-folder',
  sessions: '/sessions',
  archive: '/archive',
  state: '/state',
  runtime: '/runtime',
  dataRoot: '/data-root',
  dataRootSelect: '/data-root/select',
  dataRootMigration: '/data-root/migration',
  dataRootRollback: '/data-root/rollback',
  applicationRestart: '/application/restart',
  workspaceSelect: '/workspace/select',
  attachmentSelect: '/attachments/select',
  attachmentImport: '/attachments/import',
  workspaceList: '/workspace/list',
  workspacePreview: '/workspace/preview',
  workspaceSave: '/workspace/save',
  workspaceLayout: '/workspace/layout',
  workspaceArtifacts: '/workspace/artifacts',
  workspaceOpen: '/workspace/open',
  externalOpen: '/external/open',
  workspaceOpenVscode: '/workspace/open-vscode',
  terminalSession: '/workspace/terminal/session',
  terminalRun: '/workspace/terminal/run',
  terminalActivity: '/workspace/terminal/activity',
  terminalStream: '/workspace/terminal/stream',
  configProviders: '/config/providers',
  configApiKey: '/config/apikey',
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
  archiveSessions: '/archive/sessions/',
  archiveProjects: '/archive/projects/',
  terminalSessions: '/workspace/terminal/session/',
  plugins: '/plugins/',
  skills: '/skills/',
  memoryNodes: '/memory/tree/nodes/',
  memoryResources: '/memory/tree/resources/',
  memoryProjects: '/memory/projects/',
  memoryFiles: '/memory/files/',
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
