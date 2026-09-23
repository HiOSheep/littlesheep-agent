// Skills, memory policy, memory tree and project-memory projection routes.

import type { Config } from '@littlesheep/config'
import type { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import type { AgentRunner } from '@littlesheep/runner'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import type { ProjectIndex } from '../project-index.js'
import {
  buildMemoryTreePayload,
  buildMemoryTreeNodeDetail,
  manageRuntimeMemoryNode,
  manageRuntimeMemoryResource,
  type MemoryNodeManagementAction,
  type MemoryResourceManagementAction,
} from '../memory-tree-control.js'
import { json, readJson, resolveRunner, type LocalAppApiRequest } from './http.js'
import { routeMemoryAtom } from './memory-atom-routes.js'
import type { MemoryEmbeddingModelController } from '../memory-embedding-model-control.js'
import { routeMemoryMigration } from './memory-migration-routes.js'
import {
  listUserMemoryFiles,
  readUserMemoryFile,
  writeUserMemoryFile,
} from '../memory-files.js'
import type {
  MemoryActivationLevelCounts,
  MemoryFilesPayload,
} from '../../shared/memory-control-contracts.js'

export interface MemoryRouteContext {
  getRunner: () => AgentRunner | undefined
  projectIndex: ProjectIndex
  getConfig: () => Config
  setConfig: (config: Config) => void
  updateRuntimeConfig: (config: Config) => Promise<Config | void>
  mutateRuntimeConfig?: <T>(operation: () => Promise<T>) => Promise<T>
  memoryV3MigrationManager?: MemoryV2ToV3MigrationManager
  memoryEmbeddingModelManager: MemoryEmbeddingModelController
  selectProjectMemoryExport?: (projectName: string, projectPath: string) => Promise<string | null>
  selectMemoryResourceSource?: () => Promise<string | null>
  selectMemoryAtomExport?: (suggestedName: string) => Promise<string | null>
  dataDir: string
}

const MEMORY_NODE_MANAGEMENT_ACTIONS = new Set<MemoryNodeManagementAction>([
  'archive',
  'restore',
  'delete',
  'promote',
  'demote',
])

const MEMORY_RESOURCE_MANAGEMENT_ACTIONS = new Set<MemoryResourceManagementAction>([
  'disable',
  'restore',
  'remove',
  'rebind',
])

export async function routeMemory(
  request: LocalAppApiRequest,
  context: MemoryRouteContext,
): Promise<boolean> {
  const { req, res, url, path, method } = request
  const runner = resolveRunner(context.getRunner)
  const mutateRuntimeConfig = context.mutateRuntimeConfig ?? (<T>(operation: () => Promise<T>) => operation())

  if (await routeMemoryAtom(request, {
    runner,
    selectMemoryAtomExport: context.selectMemoryAtomExport,
  })) return true
  if (await routeMemoryMigration(request, {
    runner,
    migrationManager: context.memoryV3MigrationManager,
    embeddingModelManager: context.memoryEmbeddingModelManager,
  })) return true

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.skills) {
    const skills = runner.infra.skillLoader.index.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }))
    json(res, 200, { skills })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.memoryFiles) {
    const [files, repository, semanticCache] = await Promise.all([
      listUserMemoryFiles(context.dataDir),
      runner.infra.memoryRepository.management.status(),
      runner.infra.sessionManager.semanticCacheActivationOverview(),
    ])
    const durableMemory = repository.catalog?.activation ?? emptyActivationCounts()
    const payload: MemoryFilesPayload = {
      files,
      activation: {
        levels: addActivationCounts(durableMemory, semanticCache),
        sources: { durableMemory, semanticCache },
        computedAt: new Date().toISOString(),
      },
    }
    json(res, 200, payload)
    return true
  }

  const memoryFileName = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryFiles)
  if (memoryFileName !== null && (method === 'GET' || method === 'PUT')) {
    if (method === 'GET') {
      const file = await readUserMemoryFile(context.dataDir, memoryFileName)
      if (!file) {
        json(res, 404, { error: `memory file not found: ${memoryFileName}` })
        return true
      }
      json(res, 200, file)
      return true
    }
    const body = await readJson(req)
    const content = typeof body.content === 'string' ? body.content : undefined
    if (content === undefined) {
      json(res, 400, { error: 'content must be a string' })
      return true
    }
    try {
      const file = await writeUserMemoryFile(context.dataDir, memoryFileName, content)
      if (!file) {
        json(res, 404, { error: `memory file not found: ${memoryFileName}` })
        return true
      }
      await runner.infra.memoryService.loadBootstrapFiles(context.dataDir)
      json(res, 200, file)
    } catch (error) {
      json(res, 403, { error: (error as Error).message })
    }
    return true
  }

  const skillName = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.skills)
  if (method === 'GET' && skillName !== null) {
    const skill = runner.infra.skillLoader.index.skills.find((entry) => entry.name === skillName)
    if (!skill) {
      json(res, 404, { error: `skill not found: ${skillName}` })
      return true
    }
    const body = await runner.infra.skillLoader.loadBody(skillName)
    json(res, 200, { name: skill.name, description: skill.description, body: body ?? '' })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.memoryPolicy) {
    const body = await readJson(req)
    const threshold = typeof body.experienceWriteThreshold === 'number'
      ? body.experienceWriteThreshold
      : Number.NaN
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      json(res, 400, { error: 'experienceWriteThreshold must be a number between 0 and 1' })
      return true
    }
    return mutateRuntimeConfig(async () => {
      const current = context.getConfig()
      const next: Config = {
        ...current,
        memory: {
          ...current.memory,
          experienceWriteThreshold: threshold,
        },
      }
      const applied = await context.updateRuntimeConfig(next) ?? next
      context.setConfig(applied)
      json(res, 200, { experienceWriteThreshold: threshold })
      return true
    })
  }

  const memoryNodeId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryNodes, '/manage')
  if (method === 'POST' && memoryNodeId !== null) {
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    if (!MEMORY_NODE_MANAGEMENT_ACTIONS.has(action as MemoryNodeManagementAction)) {
      json(res, 400, { error: 'action must be archive, restore, delete, promote or demote' })
      return true
    }
    const outcome = await manageRuntimeMemoryNode(
      runner,
      memoryNodeId,
      action as MemoryNodeManagementAction,
      typeof body.reason === 'string' ? body.reason : undefined,
    )
    if (outcome.status === 'not_found') {
      json(res, 404, { error: `memory node not found: ${memoryNodeId}` })
      return true
    }
    if (outcome.status === 'invalid') {
      json(res, 409, { error: outcome.error })
      return true
    }
    json(res, 200, { node: outcome.node, audit: outcome.audit })
    return true
  }

  const memoryNodeDetailId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryNodes)
  if (method === 'GET' && memoryNodeDetailId !== null) {
    const disclosure = url.searchParams.get('disclosure') ?? 'D2'
    if (disclosure !== 'D2' && disclosure !== 'D3') {
      json(res, 400, { error: 'disclosure must be D2 or D3' })
      return true
    }
    const detail = await buildMemoryTreeNodeDetail(runner, memoryNodeDetailId, disclosure)
    if (!detail) {
      json(res, 404, { error: `memory node not found: ${memoryNodeDetailId}` })
      return true
    }
    json(res, 200, detail)
    return true
  }

  const memoryResourceId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryResources, '/manage')
  if (method === 'POST' && memoryResourceId !== null) {
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    if (!MEMORY_RESOURCE_MANAGEMENT_ACTIONS.has(action as MemoryResourceManagementAction)) {
      json(res, 400, { error: 'action must be disable, restore, remove or rebind' })
      return true
    }
    let sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : undefined
    if (action === 'rebind' && !sourcePath) {
      if (!context.selectMemoryResourceSource) {
        json(res, 501, { error: 'memory resource relocation dialog is unavailable' })
        return true
      }
      sourcePath = await context.selectMemoryResourceSource() ?? undefined
      if (!sourcePath) {
        json(res, 200, { cancelled: true })
        return true
      }
    }
    const outcome = await manageRuntimeMemoryResource(
      runner,
      memoryResourceId,
      action as MemoryResourceManagementAction,
      {
        sourcePath,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      },
    )
    if (outcome.status === 'not_found') {
      json(res, 404, { error: `memory resource not found: ${memoryResourceId}` })
      return true
    }
    if (outcome.status === 'invalid') {
      json(res, 409, { error: outcome.error })
      return true
    }
    json(res, 200, { cancelled: false, ...outcome.result as Record<string, unknown> })
    return true
  }

  const projectProjectionId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryProjects, '/projection')
  if (projectProjectionId !== null && (method === 'GET' || method === 'POST')) {
    const project = (await context.projectIndex.list()).find((entry) => entry.id === projectProjectionId)
    if (!project) {
      json(res, 404, { error: `project not found: ${projectProjectionId}` })
      return true
    }
    const target = { id: project.id, name: project.name, path: project.path }
    if (method === 'GET') {
      json(res, 200, await runner.infra.memoryService.getProjectMemoryProjectionState(target))
      return true
    }
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'enable') {
      json(res, 200, await runner.infra.memoryService.enableProjectMemoryProjection(target, {
        overwriteExisting: body.overwriteExisting === true,
      }))
      return true
    }
    if (action === 'sync') {
      json(res, 200, await runner.infra.memoryService.syncProjectMemoryProjection(target, {
        force: body.force === true,
      }))
      return true
    }
    if (action === 'disable') {
      json(res, 200, await runner.infra.memoryService.disableProjectMemoryProjection(target, {
        removeProjection: body.removeProjection === true,
      }))
      return true
    }
    if (action === 'export') {
      if (!context.selectProjectMemoryExport) {
        json(res, 501, { error: 'project memory export dialog is unavailable' })
        return true
      }
      const outputPath = await context.selectProjectMemoryExport(project.name, project.path)
      if (!outputPath) {
        json(res, 200, { cancelled: true })
        return true
      }
      const exported = await runner.infra.memoryService.exportShareableProjectMemory(
        target,
        outputPath,
        { overwriteExisting: true },
      )
      json(res, 200, { cancelled: false, export: exported })
      return true
    }
    json(res, 400, { error: 'action must be enable, sync, disable or export' })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.memoryTree) {
    json(res, 200, await buildMemoryTreePayload(runner, context.projectIndex, context.getConfig()))
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.memory) {
    const store = runner.infra.memoryStore
    const dailyDates = await store.listDailyDates()
    let longTerm = ''
    try {
      longTerm = await store.readLongTerm()
    } catch {
      // Long-term memory is optional until its first write.
    }
    json(res, 200, {
      dailyDates: dailyDates.slice(-30),
      longTerm: longTerm.slice(0, 2000),
      experienceCount: (await runner.infra.experienceStore.list()).length,
    })
    return true
  }

  return false
}

function emptyActivationCounts(): MemoryActivationLevelCounts {
  return { high: 0, medium: 0, low: 0 }
}

function addActivationCounts(
  left: MemoryActivationLevelCounts,
  right: MemoryActivationLevelCounts,
): MemoryActivationLevelCounts {
  return {
    high: left.high + right.high,
    medium: left.medium + right.medium,
    low: left.low + right.low,
  }
}
