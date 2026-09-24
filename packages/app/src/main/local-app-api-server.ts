// Loopback-only Renderer/Main bridge. Domain routes live in ./local-app-api.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { closeHttpServer } from './http-server-shutdown.js'
import { bindFetchCompatibleHttpServer } from './fetch-compatible-port.js'
import { join } from 'node:path'
import type { AgentRunner } from '@littlesheep/runner'
import type { Config } from '@littlesheep/config'
import { ProjectRebindingService } from './project-rebinding.js'
import { sameBoundPath } from './path-rebinding.js'
import { ManagedAttachmentCache } from './attachment-cache.js'
import type { PluginHost } from '@littlesheep/plugins'
import { HttpError, RuntimeNotReadyError, json, type LocalAppApiRequest } from './local-app-api/http.js'
import { LOCAL_APP_API_ROUTES } from '../shared/local-app-api-routes.js'
import { routeExtensions } from './local-app-api/extension-routes.js'
import { routeRuntime } from './local-app-api/runtime-routes.js'
import { routeMemory } from './local-app-api/memory-routes.js'
import { routeSessions } from './local-app-api/session-routes.js'
import { routeProjects } from './local-app-api/project-routes.js'
import { routeWorkspace } from './local-app-api/workspace-routes.js'
import { routeBrowser } from './local-app-api/browser-routes.js'
import { routeDevelopmentEnvironments } from './local-app-api/development-environment-routes.js'
import { routeRunLifecycle } from './local-app-api/run-lifecycle-routes.js'
import { TerminalRouter } from './local-app-api/terminal-routes.js'
import { RunRouter } from './local-app-api/run-routes.js'
import type { LocalAppApiServer, LocalAppApiServerOptions } from './local-app-api/contracts.js'
import { WebProviderCheckCoordinator } from './local-app-api/web-provider-check.js'
import { MemoryEmbeddingModelManager, type MemoryEmbeddingModelController } from './memory-embedding-model-control.js'
import { DevelopmentEnvironmentManager } from './development-environments.js'

export type { LocalAppApiServer, LocalAppApiServerOptions } from './local-app-api/contracts.js'
export async function startLocalAppApiServer(
  opts: LocalAppApiServerOptions,
): Promise<LocalAppApiServer> {
  // The Runner may not exist yet: the listener starts first so the desktop
  // window can show real session metadata while execution is still starting.
  // `opts.getRunner()` returns undefined until the composition root publishes
  // one; every Runner-backed route then fails with 503 runtime-not-ready.
  let currentPluginHost: PluginHost | null = null
  const requireRunner = (): AgentRunner => {
    const current = opts.getRunner()
    if (!current) throw new RuntimeNotReadyError()
    return current
  }
  let currentConfig: Config = opts.config
  let sessionMutationQueue: Promise<void> = Promise.resolve()
  let runtimeConfigMutationQueue: Promise<void> = Promise.resolve()
  let runRouterPromise: Promise<RunRouter> | undefined
  let activeRunRouter: RunRouter | undefined
  let runRouterGeneration = 0
  const mutateSession = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = sessionMutationQueue.then(operation)
    sessionMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const mutateRuntimeConfig = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = runtimeConfigMutationQueue.then(operation)
    runtimeConfigMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const webProviderCheck = new WebProviderCheckCoordinator(requireRunner, () => currentConfig)
  const projectRebinding = new ProjectRebindingService({
    dataDir: opts.dataDir,
    projectIndex: opts.projectIndex,
    sessionIndex: opts.sessionIndex,
    archiveIndex: opts.archiveIndex,
    workspaceArtifactIndex: opts.workspaceArtifactIndex,
    terminalActivityIndex: opts.terminalActivityIndex,
    workspaceLayoutIndex: opts.workspaceLayoutIndex,
    rebindMemory: (previous, project) => requireRunner().infra.memoryService.rebindProjectPath(previous, project),
    rebindRuntimeWorkspace: (fromPath, toPath) => mutateRuntimeConfig(async () => {
      const currentWorkspace = currentConfig.agents.defaults.workspace || opts.workplaceDir
      if (!sameBoundPath(currentWorkspace, fromPath)) return
      const next: Config = {
        ...currentConfig,
        agents: {
          ...currentConfig.agents,
          defaults: { ...currentConfig.agents.defaults, workspace: toPath },
        },
      }
      const applied = await opts.updateRuntimeConfig(next)
      currentConfig = applied ?? next
    }),
  })
  try {
    await projectRebinding.recoverPending()
  } catch (error) {
    console.error(`[projects] pending path rebind recovery failed: ${(error as Error).message}`)
  }
  const initializeForRunner = async (runner: AgentRunner): Promise<void> => {
    const protectedAttachmentIds = new Set<string>()
    const inspections = typeof runner.runCheckpoints?.list === 'function'
      ? await runner.runCheckpoints.list(128)
      : []
    for (const inspection of inspections) {
      if (inspection.disposition?.status === 'resumed'
        || inspection.disposition?.status === 'completed'
        || inspection.disposition?.status === 'abandoned') continue
      for (const reference of inspection.checkpoint.resumeState?.attachments ?? []) {
        protectedAttachmentIds.add(reference.cacheId)
      }
    }
    await attachmentCache.initialize(protectedAttachmentIds)
    webProviderCheck.invalidate()
  }
  const attachmentCache = new ManagedAttachmentCache({
    rootDir: join(opts.dataDir, 'attachment-cache'),
  })
  const embeddingModelManager = opts.memoryEmbeddingModelManager ?? new MemoryEmbeddingModelManager({ dataDir: opts.dataDir })
  const respondReadinessToPath = (requestPath: string): { payload: unknown } | undefined => (
    requestPath === LOCAL_APP_API_ROUTES.readiness
      ? { payload: opts.getExecutionReadiness?.() }
      : undefined
  )
  const developmentEnvironmentManager = opts.developmentEnvironmentManager ?? new DevelopmentEnvironmentManager({
    dataDir: opts.dataDir,
    electronExecutable: process.execPath,
  })
  const routeOptions = {
    ...opts,
    getRunner: requireRunner,
    respondReadiness: respondReadinessToPath,
    memoryEmbeddingModelManager: embeddingModelManager,
    ...webProviderCheck.routeBindings(),
  }
  const terminalRouter = new TerminalRouter()
  await developmentEnvironmentManager.initialize()

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    void (async () => {
      const readiness = routeOptions.respondReadiness?.(req.url ?? '/')
      if (readiness) {
        json(res, 200, readiness.payload)
        return
      }
      // Recovery can take much longer than the listener startup on an existing
      // data root. Never make metadata and workspace requests wait for it.
      const runRouter = activeRunRouter
      return route(
        req,
        res,
        requireRunner,
        () => currentPluginHost,
        () => currentConfig,
        (c: Config) => {
          webProviderCheck.invalidateIfWebChanged(c)
          currentConfig = c
        },
        routeOptions,
        mutateSession,
        mutateRuntimeConfig,
        projectRebinding,
        attachmentCache,
        runRouter,
        terminalRouter,
        developmentEnvironmentManager,
      )
    })().catch((err) => {
      const status = err instanceof HttpError ? err.status : 500
      if (!res.headersSent) {
        json(res, status, { error: (err as Error).message })
      } else {
        res.end()
      }
    })
  })

  const port = await bindFetchCompatibleHttpServer(server, opts.port ?? 0)
  return {
    port,
    setRunner: async (r: AgentRunner) => {
      const generation = ++runRouterGeneration
      const pending = RunRouter.create(r)
      runRouterPromise = pending
      await initializeForRunner(r)
      const next = await pending
      if (generation === runRouterGeneration) activeRunRouter = next
      else next.stop()
    },
    setPluginHost: (host: PluginHost) => {
      currentPluginHost = host
    },
    setConfig: (c: Config) => {
      webProviderCheck.invalidateIfWebChanged(c)
      currentConfig = c
    },
    stop: async () => {
      const router = await runRouterPromise?.catch(() => undefined)
      router?.stop()
      if (activeRunRouter !== router) activeRunRouter?.stop()
      terminalRouter.stop()
      await embeddingModelManager.shutdown()
      await closeHttpServer(server)
    },
  }
}

type RunnerGetter = () => AgentRunner | undefined
type PluginHostGetter = () => PluginHost | null

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  getRunner: RunnerGetter,
  getPluginHost: PluginHostGetter,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  opts: LocalAppApiServerOptions & { memoryEmbeddingModelManager: MemoryEmbeddingModelController },
  mutateSession: <T>(operation: () => Promise<T>) => Promise<T>,
  mutateRuntimeConfig: <T>(operation: () => Promise<T>) => Promise<T>,
  projectRebinding: ProjectRebindingService,
  attachmentCache: ManagedAttachmentCache,
  runRouter: RunRouter | undefined,
  terminalRouter: TerminalRouter,
  developmentEnvironmentManager: DevelopmentEnvironmentManager,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const sessionIndex = opts.sessionIndex
  const projectIndex = opts.projectIndex
  const archiveIndex = opts.archiveIndex
  const terminalActivityIndex = opts.terminalActivityIndex
  const workspaceArtifactIndex = opts.workspaceArtifactIndex
  const workspaceLayoutIndex = opts.workspaceLayoutIndex

  const routeRequest: LocalAppApiRequest = { req, res, url, path, method }
  if (await routeRunLifecycle(routeRequest, {
    runRouter,
    getRunner,
    getConfig,
    options: opts,
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
    mutateSession,
  })) return

  if (await routeRuntime(routeRequest, {
    ...opts,
    getRunner,
    getConfig,
    setConfig,
    mutateRuntimeConfig,
  })) return

  if (await routeDevelopmentEnvironments(routeRequest, {
    manager: developmentEnvironmentManager,
    selectSource: opts.selectDevelopmentEnvironmentSource,
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

  if (await routeBrowser(routeRequest, opts)) return

  if (await terminalRouter.route(routeRequest, {
    getConfig,
    dataDir: opts.dataDir,
    workplaceDir: opts.workplaceDir,
    terminalActivityIndex,
    developmentEnvironmentManager,
  })) return

  if (await routeExtensions(routeRequest, {
    getPluginHost,
    getConfig,
    setConfig,
    dataDir: opts.dataDir,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    mutateRuntimeConfig,
  })) return

  if (await routeMemory(routeRequest, {
    getRunner,
    projectIndex, dataDir: opts.dataDir,
    getConfig, setConfig,
    memoryV3MigrationManager: opts.memoryV3MigrationManager,
    memoryEmbeddingModelManager: opts.memoryEmbeddingModelManager,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    mutateRuntimeConfig,
    selectProjectMemoryExport: opts.selectProjectMemoryExport,
    selectMemoryResourceSource: opts.selectMemoryResourceSource,
    selectMemoryAtomExport: opts.selectMemoryAtomExport,
  })) return
  json(res, 404, { error: `Not found: ${method} ${path}` })
}
