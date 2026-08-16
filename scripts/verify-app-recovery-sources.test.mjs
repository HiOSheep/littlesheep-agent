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
})
