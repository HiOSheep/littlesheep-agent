// Public construction and lifecycle contracts for the Local App API server.

import type { Config } from '@littlesheep/config'
import type { PluginHost } from '@littlesheep/plugins'
import type { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import type { AgentRunner } from '@littlesheep/runner'
import type { ArchiveIndex } from '../archive-index.js'
import type { AttachmentRef } from '../attachments.js'
import type { DataRootMigrationManager } from '../data-root-migration.js'
import type { ProjectIndex } from '../project-index.js'
import type { SessionIndex } from '../session-index.js'
import type { TerminalActivityIndex } from '../terminal-activity-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import type { WorkspaceLayoutIndex } from '../workspace-layout-index.js'
import type { MemoryEmbeddingModelController } from '../memory-embedding-model-control.js'
import type { BrowserStorageOperationResult, BrowserStorageStatus } from '../../shared/browser-control-contracts.js'
import type { DevelopmentEnvironmentManager } from '../development-environments.js'
import type { DesktopAcceptanceSnapshot } from '../desktop-shell.js'
import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunActionOutcome,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import type { RuntimeWebProviderCheck } from '../../shared/runtime-api-contracts.js'

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
  updateRuntimeConfig: (config: Config) => Promise<Config | void>
  selectWorkspace?: () => Promise<string | null>
  selectAttachments?: () => Promise<AttachmentRef[]>
  selectProjectMemoryExport?: (projectName: string, projectPath: string) => Promise<string | null>
  selectMemoryResourceSource?: () => Promise<string | null>
  selectMemoryAtomExport?: (suggestedName: string) => Promise<string | null>
  memoryV3MigrationManager?: MemoryV2ToV3MigrationManager
  memoryEmbeddingModelManager?: MemoryEmbeddingModelController
  dataRootManager?: DataRootMigrationManager
  selectDataRootTarget?: () => Promise<string | null>
  restartApplication?: () => void
  listActiveRuns?: () => RuntimeActiveRunSnapshot[]
  subscribeActiveRuns?: (
    listener: (runs: RuntimeActiveRunSnapshot[]) => void,
  ) => () => void
  controlActiveRun?: (
    runId: string,
    action: RuntimeActiveRunAction,
    reason?: string,
  ) => RuntimeActiveRunActionOutcome
  getBrowserStorageStatus?: () => Promise<BrowserStorageStatus>
  clearBrowserCache?: () => Promise<BrowserStorageOperationResult>
  clearBrowserData?: () => Promise<BrowserStorageOperationResult>
  developmentEnvironmentManager?: DevelopmentEnvironmentManager
  selectDevelopmentEnvironmentSource?: (
    environmentId: string,
    version: string | null,
  ) => Promise<string | null>
  /** Startup-scoped secret for the loopback-only Provider calibration route. */
  providerCalibrationToken?: string
  getWebProviderCheck?: () => RuntimeWebProviderCheck | undefined
  checkWebProvider?: () => Promise<RuntimeWebProviderCheck>
  /** Hidden, authenticated desktop lifecycle surface for isolated Electron acceptance only. */
  desktopAcceptance?: {
    token: string
    snapshot: () => DesktopAcceptanceSnapshot
    close: () => boolean
    show: () => void
    quit: () => void
  }
}

export interface LocalAppApiServer {
  readonly port: number
  setRunner(runner: AgentRunner): void
  setPluginHost(host: PluginHost): void
  setConfig(config: Config): void
  stop(): Promise<void>
}
