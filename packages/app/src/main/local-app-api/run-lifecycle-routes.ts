// Composes active Agent runs with desktop lifecycle controls outside the HTTP server facade.

import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import type { LocalAppApiServerOptions } from './contracts.js'
import type { LocalAppApiRequest } from './http.js'
import { routeApplicationLifecycle } from './application-lifecycle-routes.js'
import type { RunRouter } from './run-routes.js'

export interface RunLifecycleRouteContext {
  runRouter: RunRouter
  getRunner: () => AgentRunner
  getConfig: () => Config
  options: LocalAppApiServerOptions
  attachmentCache: ManagedAttachmentCache
}

export async function routeRunLifecycle(
  request: LocalAppApiRequest,
  context: RunLifecycleRouteContext,
): Promise<boolean> {
  const { options } = context
  if (await context.runRouter.route(request, {
    getRunner: context.getRunner,
    getConfig: context.getConfig,
    dataDir: options.dataDir,
    workplaceDir: options.workplaceDir,
    sessionIndex: options.sessionIndex,
    projectIndex: options.projectIndex,
    workspaceArtifactIndex: options.workspaceArtifactIndex,
    attachmentCache: context.attachmentCache,
  })) return true

  return routeApplicationLifecycle(request, {
    getRunner: context.getRunner,
    listActiveRuns: options.listActiveRuns,
    subscribeActiveRuns: options.subscribeActiveRuns,
    controlActiveRun: options.controlActiveRun,
    desktopAcceptance: options.desktopAcceptance,
  })
}
