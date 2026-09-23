// Composes active Agent runs with desktop lifecycle controls outside the HTTP server facade.

import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import type { LocalAppApiServerOptions } from './contracts.js'
import type { LocalAppApiRequest } from './http.js'
import { routeApplicationLifecycle } from './application-lifecycle-routes.js'
import type { RunRouter } from './run-routes.js'

export interface RunLifecycleRouteContext {
  /** Undefined while execution is unavailable: the run router only exists once a Runner does. */
  runRouter: RunRouter | undefined
  getRunner: () => AgentRunner | undefined
  getConfig: () => Config
  options: LocalAppApiServerOptions
  attachmentCache: ManagedAttachmentCache
}

export async function routeRunLifecycle(
  request: LocalAppApiRequest,
  context: RunLifecycleRouteContext,
): Promise<boolean> {
  const { options } = context
  // Desktop lifecycle and active-run status must answer while the Runner is
  // still starting: the isolated Electron acceptance surface polls window
  // visibility from the moment the listener exists, and the sidebar shows the
  // aggregated activity of retired runs.
  if (await routeApplicationLifecycle(request, {
    getRunner: context.getRunner,
    listActiveRuns: options.listActiveRuns,
    subscribeActiveRuns: options.subscribeActiveRuns,
    controlActiveRun: options.controlActiveRun,
    desktopAcceptance: options.desktopAcceptance,
  })) return true
  if (!context.runRouter) return false
  return context.runRouter.route(request, {
    getRunner: context.getRunner,
    getConfig: context.getConfig,
    dataDir: options.dataDir,
    workplaceDir: options.workplaceDir,
    sessionIndex: options.sessionIndex,
    projectIndex: options.projectIndex,
    workspaceArtifactIndex: options.workspaceArtifactIndex,
    attachmentCache: context.attachmentCache,
  })
}
