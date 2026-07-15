// Reconciles the durable Memory repository locator before any runtime writer starts.

import type { Config } from '@littlesheep/config'
import {
  readMemoryRepositoryLocator,
  type MemoryV2ToV3MigrationManager,
  type MemoryV3BootstrapPreparation,
} from '@littlesheep/memory-tree'

export interface PrepareMemoryV3BootstrapInput {
  dataDir: string
  config: Config
  manager: MemoryV2ToV3MigrationManager
}

export interface PreparedMemoryV3Bootstrap extends MemoryV3BootstrapPreparation {
  config: Config
  configChanged: boolean
  locatorPresent: boolean
}

export async function prepareMemoryV3Bootstrap(
  input: PrepareMemoryV3BootstrapInput,
): Promise<PreparedMemoryV3Bootstrap> {
  const existingLocator = await readMemoryRepositoryLocator(input.dataDir)
  if (!existingLocator) {
    return {
      config: input.config,
      configChanged: false,
      locatorPresent: false,
      locator: await input.manager.status(),
      operation: 'none',
    }
  }

  const preparation = await input.manager.prepareForBootstrap()
  const activeBackend = preparation.locator.activeBackend
  if (input.config.memory.repositoryBackend === activeBackend) {
    return {
      ...preparation,
      config: input.config,
      configChanged: false,
      locatorPresent: true,
    }
  }

  return {
    ...preparation,
    config: {
      ...input.config,
      memory: {
        ...input.config.memory,
        repositoryBackend: activeBackend,
      },
    },
    configChanged: true,
    locatorPresent: true,
  }
}
