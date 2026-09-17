import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = fileURLToPath(new URL('./verify-app-recovery-sources.mjs', import.meta.url))

describe('app recovery source verification', () => {
  it('accepts the bounded per-session workspace layout store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-recovery-layout-'))
    try {
      await mkdir(join(dataDir, 'workspace'), { recursive: true })
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({
        agents: { defaults: { workspace: repoRoot } },
      }))
      await writeFile(join(dataDir, 'workspace', 'layout.json'), JSON.stringify({
        version: 2,
        updatedAt: '2026-08-16T00:00:00.000Z',
        snapshots: {
          'session:session-a': {
            version: 1,
            updatedAt: '2026-08-16T00:00:00.000Z',
            workspacePath: repoRoot,
            sessionId: 'session-a',
            width: 360,
            collapsed: false,
            fullscreen: false,
            activeTab: 'files',
            openTabs: ['files'],
            openRequest: null,
            fileNavigatorCollapsed: false,
            fileNavigatorWidth: 214,
            expandedPaths: [],
            drafts: {},
            browserTabs: [],
          },
        },
      }))

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          LITTLESHEEP_DATA_DIR: dataDir,
          LITTLESHEEP_DATA_LOCATOR: join(dataDir, 'missing-locator.json'),
        },
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('workspace layout snapshot readable')
      expect(result.stdout).toContain('1 session(s), 1 tab(s), format=v2')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps intentional waiting checkpoints open while still rejecting an unsealed running head', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-recovery-checkpoint-'))
    const runId = 'source-waiting-run'
    const checkpointId = 'checkpoint-waiting-head'
    const checkpointPath = join(dataDir, 'run-checkpoints', 'waiting.json')
    try {
      await mkdir(join(dataDir, 'run-checkpoints'), { recursive: true })
      await mkdir(join(dataDir, 'execution-logs'), { recursive: true })
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({
        agents: { defaults: { workspace: repoRoot } },
      }))
      await writeFile(checkpointPath, JSON.stringify({
        id: checkpointId,
        runId,
        status: 'waiting_user',
        createdAt: '2026-09-13T00:00:00.000Z',
      }))
      await writeFile(join(dataDir, 'execution-logs', `${runId}.json`), JSON.stringify({
        runId,
        status: 'ok',
        runCheckpointId: checkpointId,
      }))

      const waiting = runRecoveryAudit(dataDir)
      expect(waiting.status, waiting.stderr).toBe(0)
      expect(waiting.stdout).toContain('[pass] successful run checkpoints are sealed')

      await writeFile(checkpointPath, JSON.stringify({
        id: checkpointId,
        runId,
        status: 'running',
        createdAt: '2026-09-13T00:00:00.000Z',
      }))
      const running = runRecoveryAudit(dataDir)
      expect(running.status).toBe(1)
      expect(running.stdout).toContain(`[fail] successful run checkpoints are sealed — ${runId}:${checkpointId}`)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

function runRecoveryAudit(dataDir) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LITTLESHEEP_DATA_DIR: dataDir,
      LITTLESHEEP_DATA_LOCATOR: join(dataDir, 'missing-locator.json'),
    },
  })
}
