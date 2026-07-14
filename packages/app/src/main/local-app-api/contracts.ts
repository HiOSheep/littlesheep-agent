// Public construction and lifecycle contracts for the Local App API server.

import type { Config } from '@littlesheep/config'
import type { PluginHost } from '@littlesheep/plugins'
import type { AgentRunner } from '@littlesheep/runner'
import type { ArchiveIndex } from '../archive-index.js'
import type { AttachmentRef } from '../attachments.js'
import type { DataRootMigrationManager } from '../data-root-migration.js'
import type { ProjectIndex } from '../project-index.js'
import type { SessionIndex } from '../session-index.js'
import type { TerminalActivityIndex } from '../terminal-activity-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import type { WorkspaceLayoutIndex } from '../workspace-layout-index.js'

export interface LocalAppApiServerOptions {
  /** Port to listen on. 0 selects a random free loopback port. */
  port?: number
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
  terminalActivityIndex: TerminalActivityIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  workspaceLayoutIndex: WorkspaceLayoutIndex
  config: Config
  dataDir: string
  workplaceDir: string
  rebuildRunner: () => Promise<void>
  updateRuntimeConfig: (config: Config) => Promise<void>
  selectWorkspace?: () => Promise<string | null>
  selectAttachments?: () => Promise<AttachmentRef[]>
  selectProjectMemoryExport?: (projectName: string, projectPath: string) => Promise<string | null>
  selectMemoryResourceSource?: () => Promise<string | null>
  dataRootManager?: DataRootMigrationManager
  selectDataRootTarget?: () => Promise<string | null>
  restartApplication?: () => void
}

export interface LocalAppApiServer {
  readonly port: number
  setRunner(runner: AgentRunner): void
  setPluginHost(host: PluginHost): void
  setConfig(config: Config): void
  stop(): Promise<void>
}
