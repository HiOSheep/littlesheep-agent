// An unconfigured custom model must actually be usable.
//
// This is the contract the change exists for: before it, a provider whose models were
// listed as bare ids resolved to NO context window, so a freshly added custom provider
// could not be used until the user looked up numbers vendors often do not publish.
//
// The assertion that matters is the runtime payload the Renderer receives, because
// that is what the model picker and the context engine read. It is taken over real
// loopback HTTP against the shipped Local App API, not by calling the resolver
// directly, so the projection (including the `assumedDefaults` flag the UI needs to
// label an assumption) is covered too.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/u, ''),
  },
}))

import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

async function startServer(providers: Config['providers']) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-provider-defaults-'))
  tempDirs.push(dataDir)
  const workplaceDir = join(dataDir, 'workplace')
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), providers }
  const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
  const server = await startLocalAppApiServer({
    getRunner: () => runner,
    port: 0,
    sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
    projectIndex: new ProjectIndex({ dataDir }),
    archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
    terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
    workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
    workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
    config,
    dataDir,
    workplaceDir,
    rebuildRunner: async () => undefined,
    updateRuntimeConfig: async (next: Config) => next,
  })
  await server.setRunner(runner)
  return server
}

describe('unconfigured custom models are usable', () => {
  it('applies the documented defaults to a bare model id and marks them as assumptions', async () => {
    const server = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-literal-fixture',
      // A bare id: the user said "this model exists" and declared nothing.
      models: ['vendor-model'],
    }])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      const payload = await response.json() as {
        providers: { id: string; models: Record<string, unknown>[] }[]
      }
      const provider = payload.providers.find((item) => item.id === 'my-gw')
      const model = provider?.models.find((item) => item.id === 'vendor-model')

      expect(model).toBeDefined()
      // Before this change these were `undefined`, which is what made the provider
      // unusable until the user supplied numbers.
      expect(model?.contextWindow).toBe(256_000)
      expect(model?.maxOutputTokens).toBe(32_000)
      // Every reasoning level, because the user expressed no preference.
      expect(model?.reasoningOptions).toEqual(['auto', 'low', 'medium', 'high', 'ultra'])
      // And the payload says the numbers are LS's defaults, so the UI can label them.
      expect(model?.assumedDefaults).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('keeps the user\'s own numbers and does not mark them as assumed', async () => {
    const server = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-literal-fixture',
      models: [{
        id: 'vendor-model',
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        reasoningOptions: ['auto', 'high'],
      }],
    }])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      const payload = await response.json() as {
        providers: { id: string; models: Record<string, unknown>[] }[]
      }
      const model = payload.providers.find((item) => item.id === 'my-gw')
        ?.models.find((item) => item.id === 'vendor-model')

      // A declaration always wins over a default, and is never labelled an assumption.
      expect(model?.contextWindow).toBe(128_000)
      expect(model?.maxOutputTokens).toBe(16_000)
      expect(model?.reasoningOptions).toEqual(['auto', 'high'])
      expect(model?.assumedDefaults).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('does not invent a window for a model the user never listed', async () => {
    const server = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-literal-fixture',
      models: ['vendor-model'],
    }])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      const payload = await response.json() as {
        providers: { id: string; models: Record<string, unknown>[] }[]
      }
      const provider = payload.providers.find((item) => item.id === 'my-gw')
      // Only what the user listed: the defaults apply to their models, not to a name
      // LS has never been told about.
      expect(provider?.models.map((model) => model.id)).toEqual(['vendor-model'])
    } finally {
      await server.stop()
    }
  })
})
