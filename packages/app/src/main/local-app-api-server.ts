// Loopback-only Renderer/Main bridge. Domain routes live in ./local-app-api.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { closeHttpServer } from './http-server-shutdown.js'
import { join } from 'node:path'
import type { AgentRunner } from '@littlesheep/runner'
import type { Config } from '@littlesheep/config'
import { ProjectRebindingService } from './project-rebinding.js'
import { sameBoundPath } from './path-rebinding.js'
import { ManagedAttachmentCache } from './attachment-cache.js'
import type { PluginHost } from '@littlesheep/plugins'
import { HttpError, json, type LocalAppApiRequest } from './local-app-api/http.js'
import { routeExtensions } from './local-app-api/extension-routes.js'
import { routeRuntime } from './local-app-api/runtime-routes.js'
import { routeMemory } from './local-app-api/memory-routes.js'
import { routeSessions } from './local-app-api/session-routes.js'
import { routeProjects } from './local-app-api/project-routes.js'
import { routeWorkspace } from './local-app-api/workspace-routes.js'
import { TerminalRouter } from './local-app-api/terminal-routes.js'
import { RunRouter } from './local-app-api/run-routes.js'
import type { LocalAppApiServer, LocalAppApiServerOptions } from './local-app-api/contracts.js'
import { MemoryEmbeddingModelManager, type MemoryEmbeddingModelController } from './memory-embedding-model-control.js'

export type { LocalAppApiServer, LocalAppApiServerOptions } from './local-app-api/contracts.js'
export async function startLocalAppApiServer(
  initialRunner: AgentRunner,
  opts: LocalAppApiServerOptions,
): Promise<LocalAppApiServer> {
  // Mutable runner reference — allows hot-swapping without restarting the
  // Local API server (port stays the same, renderer's apiBase remains valid).
  let currentRunner = initialRunner
  // The core API remains usable while the optional plugin host is absent or loading.
  let currentPluginHost: PluginHost | null = null
  let currentConfig: Config = opts.config
  const projectRebinding = new ProjectRebindingService({
    dataDir: opts.dataDir,
    projectIndex: opts.projectIndex,
    sessionIndex: opts.sessionIndex,
    archiveIndex: opts.archiveIndex,
    workspaceArtifactIndex: opts.workspaceArtifactIndex,
    terminalActivityIndex: opts.terminalActivityIndex,
    workspaceLayoutIndex: opts.workspaceLayoutIndex,
    rebindMemory: (previous, project) => currentRunner.infra.memoryService.rebindProjectPath(previous, project),
    rebindRuntimeWorkspace: async (fromPath, toPath) => {
      const currentWorkspace = currentConfig.agents.defaults.workspace || opts.workplaceDir
      if (!sameBoundPath(currentWorkspace, fromPath)) return
      const next: Config = {
        ...currentConfig,
        agents: {
          ...currentConfig.agents,
          defaults: { ...currentConfig.agents.defaults, workspace: toPath },
        },
      }
      currentConfig = next
      await opts.updateRuntimeConfig(next)
    },
  })
  try {
    await projectRebinding.recoverPending()
  } catch (error) {
    console.error(`[projects] pending path rebind recovery failed: ${(error as Error).message}`)
  }
  const attachmentCache = new ManagedAttachmentCache({
    rootDir: join(opts.dataDir, 'attachment-cache'),
  })
  const embeddingModelManager = opts.memoryEmbeddingModelManager ?? new MemoryEmbeddingModelManager({ dataDir: opts.dataDir })
  const routeOptions = { ...opts, memoryEmbeddingModelManager: embeddingModelManager }
  const runRouter = new RunRouter()
  const terminalRouter = new TerminalRouter()
  try {
    await attachmentCache.initialize()
  } catch (error) {
    console.error(`[attachments] managed cache initialization failed: ${(error as Error).message}`)
  }

  return new Promise<LocalAppApiServer>((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      route(
        req,
        res,
        () => currentRunner,
        () => currentPluginHost,
        () => currentConfig,
        (c: Config) => { currentConfig = c },
        routeOptions,
        projectRebinding,
        attachmentCache,
        runRouter,
        terminalRouter,
      ).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500
        if (!res.headersSent) {
          json(res, status, { error: (err as Error).message })
        } else {
          res.end()
        }
      })
    })

    server.on('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        setRunner: (r: AgentRunner) => {
          currentRunner = r
        },
        setPluginHost: (host: PluginHost) => {
          currentPluginHost = host
        },
        setConfig: (c: Config) => {
          currentConfig = c
        },
        stop: async () => {
          runRouter.stop()
          terminalRouter.stop()
          await embeddingModelManager.shutdown()
          await closeHttpServer(server)
        },
      })
    })
  })
}

type RunnerGetter = () => AgentRunner
type PluginHostGetter = () => PluginHost | null

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  getRunner: RunnerGetter,
  getPluginHost: PluginHostGetter,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  opts: LocalAppApiServerOptions & { memoryEmbeddingModelManager: MemoryEmbeddingModelController },
  projectRebinding: ProjectRebindingService,
  attachmentCache: ManagedAttachmentCache,
  runRouter: RunRouter,
  terminalRouter: TerminalRouter,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const runner = getRunner()
  const sessionIndex = opts.sessionIndex
  const projectIndex = opts.projectIndex
  const archiveIndex = opts.archiveIndex
  const terminalActivityIndex = opts.terminalActivityIndex
  const workspaceArtifactIndex = opts.workspaceArtifactIndex
  const workspaceLayoutIndex = opts.workspaceLayoutIndex

  const routeRequest: LocalAppApiRequest = { req, res, url, path, method }
  if (await runRouter.route(routeRequest, {
    getRunner,
    getConfig,
    workplaceDir: opts.workplaceDir,
    sessionIndex,
    projectIndex,
    workspaceArtifactIndex,
    attachmentCache,
  })) return

  if (await routeProjects(routeRequest, {
    getRunner,
    getConfig,
    workplaceDir: opts.workplaceDir,
    sessionIndex,
    projectIndex,
    archiveIndex,
    projectRebinding,
  })) return

  if (await routeSessions(routeRequest, {
    getRunner,
    sessionIndex,
    projectIndex,
    archiveIndex,
  })) return

  if (await routeRuntime(routeRequest, {
    getRunner,
    getConfig,
    setConfig,
    workplaceDir: opts.workplaceDir,
    dataDir: opts.dataDir,
    rebuildRunner: opts.rebuildRunner,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    dataRootManager: opts.dataRootManager,
    selectDataRootTarget: opts.selectDataRootTarget,
    restartApplication: opts.restartApplication,
  })) return

  if (await routeWorkspace(routeRequest, {
    getRunner,
    getConfig,
    workplaceDir: opts.workplaceDir,
    projectIndex,
    workspaceArtifactIndex,
    workspaceLayoutIndex,
    attachmentCache,
    selectWorkspace: opts.selectWorkspace,
    selectAttachments: opts.selectAttachments,
  })) return

  if (await terminalRouter.route(routeRequest, {
    getConfig,
    workplaceDir: opts.workplaceDir,
    terminalActivityIndex,
  })) return

  if (await routeExtensions(routeRequest, {
    getPluginHost,
    getConfig,
    setConfig,
    dataDir: opts.dataDir,
    updateRuntimeConfig: opts.updateRuntimeConfig,
  })) return

  if (await routeMemory(routeRequest, {
    getRunner,
    projectIndex,
    getConfig, setConfig,
    memoryV3MigrationManager: opts.memoryV3MigrationManager,
    memoryEmbeddingModelManager: opts.memoryEmbeddingModelManager,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    selectProjectMemoryExport: opts.selectProjectMemoryExport,
    selectMemoryResourceSource: opts.selectMemoryResourceSource,
    selectMemoryAtomExport: opts.selectMemoryAtomExport,
  })) return
  json(res, 404, { error: `Not found: ${method} ${path}` })
}
