import type {
  MemoryTreeDocument,
  MemoryV2ToV3MigrationManager,
  MemoryV3MigrationPreflight,
  MemoryV3MigrationValidation,
  MemoryV3PreflightOptions,
  PendingMemoryV3Rollback,
} from '@littlesheep/memory-tree'
import type { AgentRunner } from '@littlesheep/runner'
import { describe, expect, it, vi } from 'vitest'
import {
  inspectMemoryV3Migration,
  requestMemoryV3Rollback,
} from './memory-v3-migration-control.js'

describe('Memory v3 migration control', () => {
  it('uses the active repository validator and exposes precise rollback readiness', async () => {
    const source = {} as MemoryTreeDocument
    const validation = migrationValidation('a'.repeat(64))
    const validateMigrationSource = vi.fn(async () => validation)
    const manager = {
      preflight: vi.fn(async (options: MemoryV3PreflightOptions) => {
        expect(await options.validateActiveV3!(source, 'manifest')).toEqual(validation)
        return preflight({
          rollbackAvailable: true,
          rollback: {
            canRollback: true,
            sourceUnchanged: true,
            activeV3Unchanged: true,
            blockers: [],
          },
        })
      }),
    } as unknown as MemoryV2ToV3MigrationManager

    const result = await inspectMemoryV3Migration(manager, runnerWith(validateMigrationSource))

    expect(validateMigrationSource).toHaveBeenCalledWith(source, 'manifest')
    expect(result).toMatchObject({
      rollbackAvailable: true,
      rollback: {
        canRollback: true,
        sourceUnchanged: true,
        activeV3Unchanged: true,
        blockers: [],
      },
    })
  })

  it('validates the live repository before registering rollback', async () => {
    const source = {} as MemoryTreeDocument
    const validation = migrationValidation('b'.repeat(64))
    const validateMigrationSource = vi.fn(async () => validation)
    const requestRollback = vi.fn(async (options: MemoryV3PreflightOptions) => {
      expect(await options.validateActiveV3!(source, 'manifest')).toEqual(validation)
    })
    const manager = {
      requestRollback,
      preflight: vi.fn(async () => preflight({}, {
        id: 'rollback-request',
        phase: 'requested',
        attempts: 0,
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      })),
    } as unknown as MemoryV2ToV3MigrationManager

    const result = await requestMemoryV3Rollback(manager, runnerWith(validateMigrationSource))

    expect(requestRollback).toHaveBeenCalledOnce()
    expect(validateMigrationSource).toHaveBeenCalledWith(source, 'manifest')
    expect(result).toMatchObject({
      pendingOperation: { kind: 'rollback', phase: 'requested' },
      requiresRestart: true,
    })
  })
})

function runnerWith(
  validateMigrationSource: (source: MemoryTreeDocument, sourceManifestHash: string) => Promise<MemoryV3MigrationValidation>,
): AgentRunner {
  return {
    infra: {
      memoryRepository: { management: { validateMigrationSource } },
    },
  } as unknown as AgentRunner
}

function migrationValidation(validationHash: string): MemoryV3MigrationValidation {
  return {
    validationHash,
    nodeCount: 2,
    resourceCount: 1,
    atomCount: 3,
    pendingEmbeddingCount: 0,
    catalogIntegrity: 'ok',
  }
}

function preflight(
  overrides: Partial<MemoryV3MigrationPreflight> = {},
  pendingRollback?: PendingMemoryV3Rollback,
): MemoryV3MigrationPreflight {
  return {
    checkedAt: '2026-07-16T00:00:00.000Z',
    locator: {
      version: 1,
      activeBackend: 'v3',
      previousBackend: 'v2',
      lastMigration: {
        id: 'migration',
        sourceIndexHash: '1'.repeat(64),
        sourceManifestHash: '2'.repeat(64),
        snapshotManifestHash: '2'.repeat(64),
        validationHash: '3'.repeat(64),
        nodeCount: 2,
        resourceCount: 1,
        snapshotRelativePath: 'memory-tree/migrations/migration/snapshot',
        completedAt: '2026-07-16T00:00:00.000Z',
      },
      pendingRollback,
      updatedAt: '2026-07-16T00:00:00.000Z',
    },
    canMigrate: false,
    canResume: false,
    rollbackAvailable: false,
    blockers: [],
    ...overrides,
  }
}
