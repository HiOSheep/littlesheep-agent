import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, withProviderPresets, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer, type LocalAppApiServer } from './local-app-api-server.js'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('Provider calibration Local App API', () => {
  it('requires the startup token and uses the active Runner client', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-provider-calibration-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const chat = vi.fn(async () => ({
      content: 'OK',
      toolCalls: [],
      finishReason: 'stop' as const,
      usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
    }))
    const runner = {
      model: 'deepseek/deepseek-v4-flash',
      state: { model: 'deepseek-v4-flash' },
      infra: { llm: { chat, chatStream: vi.fn(), embed: vi.fn() } },
    } as unknown as AgentRunner
    const server = await createServer(runner, dataDir, workplaceDir, 'test-startup-token')
    cleanup.push(async () => {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    })
    const url = `http://127.0.0.1:${server.port}/runtime/provider-calibration`

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checks: ['chat'] }),
    })
    expect(unauthorized.status).toBe(401)
    expect(chat).not.toHaveBeenCalled()

    const authorized = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-startup-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'deepseek', checks: ['chat'], timeoutSeconds: 5 }),
    })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      checks: ['chat'],
      results: [{ check: 'chat', ok: true }],
    })
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

async function createServer(
  runner: AgentRunner,
  dataDir: string,
  workplaceDir: string,
  providerCalibrationToken: string,
): Promise<LocalAppApiServer> {
  const config = withProviderPresets(structuredClone(DEFAULT_CONFIG))
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
    providerCalibrationToken,
    rebuildRunner: vi.fn(async () => undefined),
    updateRuntimeConfig: vi.fn(async (_next: Config) => undefined),
  })
  await server.setRunner(runner)
  return server
}
