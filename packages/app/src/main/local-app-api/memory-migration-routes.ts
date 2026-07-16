// Memory v3 migration and local embedding-model preparation routes.

import type { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import type { AgentRunner } from '@littlesheep/runner'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import type { MemoryEmbeddingModelController } from '../memory-embedding-model-control.js'
import {
  cancelMemoryV3Operation,
  inspectMemoryV3Migration,
  requestMemoryV3Migration,
  requestMemoryV3Rollback,
} from '../memory-v3-migration-control.js'
import { json, type LocalAppApiRequest } from './http.js'

export async function routeMemoryMigration(
  request: LocalAppApiRequest,
  context: {
    runner: AgentRunner
    migrationManager?: MemoryV2ToV3MigrationManager
    embeddingModelManager: MemoryEmbeddingModelController
  },
): Promise<boolean> {
  const { res, path, method } = request
  if (path === LOCAL_APP_API_ROUTES.memoryEmbeddingModel) {
    if (method === 'GET') {
      json(res, 200, await context.embeddingModelManager.status())
      return true
    }
    if (method === 'POST') {
      json(res, 202, await context.embeddingModelManager.start())
      return true
    }
    if (method === 'DELETE') {
      json(res, 200, await context.embeddingModelManager.cancel())
      return true
    }
    return false
  }

  if (path === LOCAL_APP_API_ROUTES.memoryMigration) {
    if (!context.migrationManager) {
      json(res, 501, { error: 'Memory v3 migration management is not available' })
      return true
    }
    const embeddingModel = await context.embeddingModelManager.status()
    if (method === 'GET') {
      json(res, 200, await inspectMemoryV3Migration(context.migrationManager, context.runner, embeddingModel))
      return true
    }
    if (method === 'POST') {
      if (embeddingModel.state === 'preparing') {
        json(res, 409, { error: 'Local embedding model preparation is still running; cancel or wait before registering migration' })
        return true
      }
      json(res, 200, await requestMemoryV3Migration(context.migrationManager, context.runner, embeddingModel))
      return true
    }
    if (method === 'DELETE') {
      json(res, 200, await cancelMemoryV3Operation(context.migrationManager, context.runner, embeddingModel))
      return true
    }
    return false
  }

  if (path === LOCAL_APP_API_ROUTES.memoryRollback && method === 'POST') {
    if (!context.migrationManager) {
      json(res, 501, { error: 'Memory v3 migration management is not available' })
      return true
    }
    json(res, 200, await requestMemoryV3Rollback(
      context.migrationManager,
      context.runner,
      await context.embeddingModelManager.status(),
    ))
    return true
  }
  return false
}
