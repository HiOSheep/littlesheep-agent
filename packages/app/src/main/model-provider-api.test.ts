import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  },
}))

import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'
import { loadApiKeys } from './keychain.js'

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.MY_GW_API_KEY
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

async function startServer(providers: Config['providers'] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-model-provider-api-'))
  tempDirs.push(dataDir)
  const workplaceDir = join(dataDir, 'workplace')
  const updates: Config[] = []
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), providers }
  const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
  const rebuildRunner = vi.fn(async () => undefined)
  const server = await startLocalAppApiServer(runner, {
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
    rebuildRunner,
    updateRuntimeConfig: vi.fn(async (next: Config) => {
      updates.push(next)
      return next
    }),
  })
  return { server, dataDir, updates, rebuildRunner }
}

describe('model provider Local App API', () => {
  it('stores a custom provider key in the keychain and returns declared model metadata', async () => {
    const { server, dataDir, updates, rebuildRunner } = await startServer()
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/config/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: {
            id: 'my-gw',
            name: 'My Gateway',
            baseURL: 'https://gw.example.com/v1',
            apiKey: 'sk-live-1234567890',
            models: [{
              id: 'vendor-model',
              name: 'Vendor Model',
              contextWindow: 256000,
              maxOutputTokens: 32000,
              reasoningOptions: ['auto', 'high', 'ultra'],
              ultraEffort: 'xhigh',
            }],
          },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as { providers: Array<Record<string, unknown>> }
      const provider = payload.providers.find((item) => item.id === 'my-gw')
      expect(provider).toMatchObject({
        id: 'my-gw',
        name: 'My Gateway',
        baseURL: 'https://gw.example.com/v1',
        api: 'openai-chat-completions',
        envVar: 'MY_GW_API_KEY',
        requiresKey: true,
        hasKey: true,
        builtin: false,
      })
      expect(provider?.models).toEqual([{
        id: 'vendor-model',
        name: 'Vendor Model',
        declared: true,
        contextWindow: 256000,
        maxOutputTokens: 32000,
        reasoningOptions: ['auto', 'high', 'ultra'],
      }])

      // Config keeps only the reference; the plaintext key never lands there.
      const stored = updates.at(-1)?.providers.find((item) => item.id === 'my-gw')
      expect(stored?.apiKey).toBe('$MY_GW_API_KEY')
      expect(JSON.stringify(updates.at(-1))).not.toContain('sk-live-1234567890')
      expect(process.env.MY_GW_API_KEY).toBe('sk-live-1234567890')

      const keysFile = join(dataDir, 'config', 'keys.json')
      expect(existsSync(keysFile)).toBe(true)
      expect(readFileSync(keysFile, 'utf8')).not.toContain('sk-live-1234567890')
      expect(loadApiKeys(dataDir).MY_GW_API_KEY).toBe('sk-live-1234567890')
      expect(rebuildRunner).toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('updates an existing provider without dropping the stored key reference', async () => {
    const { server, updates } = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: '$MY_GW_API_KEY',
      models: ['vendor-model'],
    }])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/config/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: {
            id: 'my-gw',
            name: 'Renamed Gateway',
            baseURL: 'https://gw2.example.com/v1',
            models: [{ id: 'other-model', contextWindow: 128000 }],
          },
        }),
      })
      expect(response.status).toBe(200)
      const stored = updates.at(-1)?.providers.find((item) => item.id === 'my-gw')
      expect(stored).toMatchObject({
        name: 'Renamed Gateway',
        baseURL: 'https://gw2.example.com/v1',
        apiKey: '$MY_GW_API_KEY',
      })
      expect(stored?.models).toEqual([{ id: 'other-model', contextWindow: 128000 }])
    } finally {
      await server.stop()
    }
  })

  it('clears the key reference only when the draft sends an explicit empty key', async () => {
    const { server, updates } = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: '$MY_GW_API_KEY',
    }])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/config/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: { id: 'my-gw', baseURL: 'https://gw.example.com/v1', apiKey: '' },
        }),
      })
      expect(response.status).toBe(200)
      const stored = updates.at(-1)?.providers.find((item) => item.id === 'my-gw')
      expect(stored?.apiKey).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('rejects an invalid draft with the failing field, and refuses to delete built-in providers', async () => {
    const { server, updates } = await startServer([{
      id: 'my-gw',
      name: 'My Gateway',
      baseURL: 'https://gw.example.com/v1',
      apiKey: '$MY_GW_API_KEY',
    }])
    try {
      const invalid = await fetch(`http://127.0.0.1:${server.port}/config/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: { id: 'my-gw', baseURL: 'not-a-url' } }),
      })
      expect(invalid.status).toBe(400)
      const invalidBody = await invalid.json() as { error: string }
      expect(invalidBody.error).toContain('baseURL')
      expect(updates).toHaveLength(0)

      const builtin = await fetch(`http://127.0.0.1:${server.port}/config/providers/openai`, {
        method: 'DELETE',
      })
      expect(builtin.status).toBe(400)
      await expect(builtin.json()).resolves.toMatchObject({
        error: expect.stringContaining('built-in') as unknown as string,
      })
    } finally {
      await server.stop()
    }
  })

  it('deletes a custom provider and keeps built-in presets in the runtime payload', async () => {
    const { server, updates, rebuildRunner } = await startServer([
      {
        id: 'my-gw',
        name: 'My Gateway',
        baseURL: 'https://gw.example.com/v1',
        apiKey: '$MY_GW_API_KEY',
        models: ['vendor-model'],
      },
      {
        id: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: '$DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
      },
    ])
    try {
      const removed = await fetch(`http://127.0.0.1:${server.port}/config/providers/my-gw`, {
        method: 'DELETE',
      })
      expect(removed.status).toBe(200)
      await expect(removed.json()).resolves.toMatchObject({
        providers: [expect.objectContaining({ id: 'deepseek', builtin: true })],
      })
      expect(updates.at(-1)?.providers.map((item) => item.id)).toEqual(['deepseek'])
      expect(rebuildRunner).toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('reports built-in model numbers for preset providers as runtime facts', async () => {
    const { server } = await startServer([{
      id: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: '$DEEPSEEK_API_KEY',
      models: ['deepseek-flash', { id: 'deepseek-v4-pro' }],
    }])
    try {
      const runtime = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      const payload = await runtime.json() as { providers: Array<Record<string, unknown>> }
      const provider = payload.providers.find((item) => item.id === 'deepseek')
      expect(provider?.models).toEqual([
        {
          id: 'deepseek-flash',
          name: 'deepseek-flash',
          declared: false,
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          reasoningOptions: ['auto', 'high', 'ultra'],
        },
        {
          id: 'deepseek-v4-pro',
          name: 'deepseek-v4-pro',
          declared: true,
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          reasoningOptions: ['auto', 'high', 'ultra'],
        },
      ])
    } finally {
      await server.stop()
    }
  })
})
