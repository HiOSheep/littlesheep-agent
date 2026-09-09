import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import {
  InjectionTier,
  MemoryRepository,
  MemoryV2ToV3MigrationManager,
  createMemoryV3ExperimentMarker,
  memoryRepositoryLocatorPath,
} from '@littlesheep/memory-tree'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareMemoryV3Bootstrap } from './memory-v3-bootstrap.js'

const MIGRATION_TEST_TIMEOUT_MS = 90_000

describe('Memory v3 application bootstrap', () => {
  const directories: string[] = []

  afterEach(async () => {
    for (const directory of directories.splice(0)) await removeDirectoryWithRetry(directory)
  })

  it('leaves an unversioned data root and isolated experiment config untouched', async () => {
    const dataDir = await createDataDir(directories)
    await createMemoryV3ExperimentMarker(dataDir)
    const config = structuredClone(DEFAULT_CONFIG)
    config.memory.repositoryBackend = 'v3'
    const manager = new MemoryV2ToV3MigrationManager({ dataDir })

    const prepared = await prepareMemoryV3Bootstrap({ dataDir, config, manager })

    expect(prepared).toMatchObject({ locatorPresent: false, configChanged: false, operation: 'none' })
    expect(prepared.config.memory.repositoryBackend).toBe('v3')
    expect(existsSync(memoryRepositoryLocatorPath(dataDir))).toBe(false)
  })

  it('executes a registered migration before runtime construction and aligns config to v3', async () => {
    const dataDir = await createDataDir(directories)
    await seedV2(dataDir)
    const manager = new MemoryV2ToV3MigrationManager({ dataDir })
    await manager.requestMigration()

    const prepared = await prepareMemoryV3Bootstrap({
      dataDir,
      config: structuredClone(DEFAULT_CONFIG),
      manager,
    })

    expect(prepared).toMatchObject({
      locatorPresent: true,
      configChanged: true,
      operation: 'migration',
      locator: { activeBackend: 'v3' },
    })
    expect(prepared.config.memory.repositoryBackend).toBe('v3')
  }, MIGRATION_TEST_TIMEOUT_MS)

  it('keeps v3 active when bootstrap catches a stale rollback preflight', async () => {
    const dataDir = await createDataDir(directories)
    await seedV2(dataDir)
    const manager = new MemoryV2ToV3MigrationManager({ dataDir })
    await manager.migrate()
    const repository = new MemoryRepository({ dataDir, backend: 'v3' })
    await repository.initialize()
    await repository.write(memoryIntent('post-migration'))
    repository.close()
    const migrated = await manager.status()
    await manager.requestRollback({
      validateActiveV3: async () => ({
        validationHash: migrated.lastMigration!.validationHash,
        nodeCount: migrated.lastMigration!.nodeCount,
        resourceCount: migrated.lastMigration!.resourceCount,
        atomCount: migrated.lastMigration!.nodeCount,
        pendingEmbeddingCount: 0,
        catalogIntegrity: 'ok',
      }),
    })
    const config = structuredClone(DEFAULT_CONFIG)
    config.memory.repositoryBackend = 'v2'

    const prepared = await prepareMemoryV3Bootstrap({ dataDir, config, manager })

    expect(prepared).toMatchObject({
      locatorPresent: true,
      configChanged: true,
      operation: 'rollback',
      locator: { activeBackend: 'v3', pendingRollback: { phase: 'recovery' } },
    })
    expect(prepared.error).toMatch(/differs|lose data|changed/i)
    expect(prepared.config.memory.repositoryBackend).toBe('v3')

    const cancelled = await manager.cancelPending()
    expect(cancelled).toMatchObject({ activeBackend: 'v3' })
    expect(cancelled.pendingRollback).toBeUndefined()
    await expect(manager.prepareForBootstrap()).resolves.toMatchObject({ operation: 'none' })
  })
})

async function seedV2(dataDir: string): Promise<void> {
  const repository = new MemoryRepository({ dataDir, backend: 'v2' })
  await repository.initialize()
  await repository.write(memoryIntent('before-migration'))
  repository.close()
}

function memoryIntent(sourceRunId: string) {
  return {
    branch: 'long-term' as const,
    parentNodeId: 'long-term:root',
    scope: 'global' as const,
    tier: InjectionTier.T2_RELEVANT,
    summary: `Memory from ${sourceRunId}`,
    content: `Durable content from ${sourceRunId}.`,
    retrievalKeys: ['bootstrap', sourceRunId],
    sourceRunId,
    sourceStage: 'evolve' as const,
    sourceRefs: [`conversation-source:${sourceRunId}:user-message:seed`],
    importance: 0.8,
    confidence: 0.9,
    reason: 'Bootstrap migration test.',
  }
}

async function createDataDir(directories: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-bootstrap-'))
  directories.push(dataDir)
  return dataDir
}

async function removeDirectoryWithRetry(directory: string, attempts = 12): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') || attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}
