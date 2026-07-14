import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BRANDING, type BrandingConfig } from '@littlesheep/branding'
import { DataRootMigrationManager } from './data-root-migration.js'

let testRoot: string
let sourceDir: string
let targetDir: string
let branding: BrandingConfig

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'ls-data-root-'))
  sourceDir = join(testRoot, 'source')
  targetDir = join(testRoot, 'target')
  mkdirSync(sourceDir, { recursive: true })
  process.env.LITTLESHEEP_DATA_LOCATOR = join(testRoot, 'location.json')
  delete process.env.LITTLESHEEP_DATA_DIR
  branding = { ...DEFAULT_BRANDING, dataDir: sourceDir }
})

afterEach(() => {
  delete process.env.LITTLESHEEP_DATA_LOCATOR
  delete process.env.LITTLESHEEP_DATA_DIR
  rmSync(testRoot, { recursive: true, force: true })
})

describe('DataRootMigrationManager', () => {
  it('copies managed data, rebinds internal metadata, preserves external paths, and skips links', async () => {
    const externalProject = join(testRoot, 'external-project')
    mkdirSync(externalProject, { recursive: true })
    writeJson(join(sourceDir, 'config.json'), {
      agents: { defaults: { workspace: join(sourceDir, 'workplace') } },
    })
    writeJson(join(sourceDir, 'sessions.json'), {
      sessions: [
        { id: 'default', workspacePath: join(sourceDir, 'workplace') },
        { id: 'external', workspacePath: externalProject },
      ],
    })
    writeJson(join(sourceDir, 'workspace', 'layout.json'), {
      workspacePath: join(sourceDir, 'workplace'),
      activeTab: fileTab(sourceDir, join(sourceDir, 'workplace', 'note.md')),
      openTabs: [fileTab(sourceDir, join(sourceDir, 'workplace', 'note.md'))],
      drafts: {
        [fileTab(sourceDir, join(sourceDir, 'workplace', 'note.md'))]: {
          path: join(sourceDir, 'workplace', 'note.md'),
        },
      },
    })
    writeFile(join(sourceDir, 'workplace', 'note.md'), 'hello')

    const linkedDirectory = join(sourceDir, 'linked-external')
    let linkCreated = false
    try {
      symlinkSync(externalProject, linkedDirectory, 'junction')
      linkCreated = true
    } catch {
      // Some CI environments disable link creation. The migration still tests it when available.
    }

    const manager = new DataRootMigrationManager({ branding })
    const requested = await manager.requestMigration(targetDir)
    expect(requested.requiresRestart).toBe(true)

    const result = await manager.prepareForBootstrap()

    expect(result.status.currentDataDir).toBe(targetDir)
    expect(result.status.previousDataDir).toBe(sourceDir)
    expect(result.status.pendingMigration).toBeUndefined()
    expect(existsSync(sourceDir)).toBe(true)
    expect(readFileSync(join(targetDir, 'workplace', 'note.md'), 'utf8')).toBe('hello')
    if (linkCreated) expect(existsSync(join(targetDir, 'linked-external'))).toBe(false)

    const config = readJson(join(targetDir, 'config.json'))
    expect(config.agents.defaults.workspace).toBe(join(targetDir, 'workplace'))
    const sessions = readJson(join(targetDir, 'sessions.json')).sessions
    expect(sessions[0].workspacePath).toBe(join(targetDir, 'workplace'))
    expect(sessions[1].workspacePath).toBe(externalProject)
    const layout = readJson(join(targetDir, 'workspace', 'layout.json'))
    expect(layout.workspacePath).toBe(join(targetDir, 'workplace'))
    expect(decodeURIComponent(layout.activeTab)).toContain(targetDir)
    expect(result.metadata?.changedFiles).toBeGreaterThanOrEqual(3)
  })

  it('rejects non-empty and overlapping targets before registering a migration', async () => {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'user.txt'), 'keep', 'utf8')
    const manager = new DataRootMigrationManager({ branding })

    await expect(manager.requestMigration(targetDir)).rejects.toThrow('不是空目录')
    await expect(manager.requestMigration(join(sourceDir, 'nested'))).rejects.toThrow('互相包含')
    expect(readFileSync(join(targetDir, 'user.txt'), 'utf8')).toBe('keep')
  })

  it('recovers when the target was committed before the locator switch', async () => {
    writeFile(join(sourceDir, 'state.txt'), 'committed')
    let interrupted = false
    const first = new DataRootMigrationManager({
      branding,
      faultInjector: (point) => {
        if (point === 'after-target-commit' && !interrupted) {
          interrupted = true
          throw new Error('simulated process stop')
        }
      },
    })
    await first.requestMigration(targetDir)

    const stopped = await first.prepareForBootstrap()
    expect(stopped.status.currentDataDir).toBe(sourceDir)
    expect(stopped.status.pendingMigration?.phase).toBe('committing')
    expect(readFileSync(join(targetDir, 'state.txt'), 'utf8')).toBe('committed')

    const recovered = await new DataRootMigrationManager({ branding }).prepareForBootstrap()
    expect(recovered.status.currentDataDir).toBe(targetDir)
    expect(recovered.status.pendingMigration).toBeUndefined()
  })

  it('keeps the old root active after verification failure and resumes from staging', async () => {
    writeFile(join(sourceDir, 'state.txt'), 'original')
    let corrupted = false
    const first = new DataRootMigrationManager({
      branding,
      faultInjector: (point, context) => {
        if (point === 'after-copy' && !corrupted) {
          corrupted = true
          writeFileSync(join(context.stageDir, 'state.txt'), 'corrupt', 'utf8')
        }
      },
    })
    await first.requestMigration(targetDir)

    const failed = await first.prepareForBootstrap()
    expect(failed.status.currentDataDir).toBe(sourceDir)
    expect(failed.status.pendingMigration?.phase).toBe('failed')
    expect(readFileSync(join(sourceDir, 'state.txt'), 'utf8')).toBe('original')

    const resumed = await new DataRootMigrationManager({ branding }).prepareForBootstrap()
    expect(resumed.status.currentDataDir).toBe(targetDir)
    expect(readFileSync(join(targetDir, 'state.txt'), 'utf8')).toBe('original')
  })

  it('registers rollback for the next start and switches without deleting either root', async () => {
    writeFile(join(sourceDir, 'state.txt'), 'source')
    const manager = new DataRootMigrationManager({ branding })
    await manager.requestMigration(targetDir)
    await manager.prepareForBootstrap()

    const pending = await manager.requestRollback()
    expect(pending.currentDataDir).toBe(targetDir)
    expect(pending.pendingRollback?.toDir).toBe(sourceDir)

    const rolledBack = await new DataRootMigrationManager({ branding }).prepareForBootstrap()
    expect(rolledBack.status.currentDataDir).toBe(sourceDir)
    expect(rolledBack.status.previousDataDir).toBe(targetDir)
    expect(existsSync(sourceDir)).toBe(true)
    expect(existsSync(targetDir)).toBe(true)
  })

  it('disables application-managed migration when the environment owns the data root', async () => {
    process.env.LITTLESHEEP_DATA_DIR = join(testRoot, 'environment-root')
    const manager = new DataRootMigrationManager({ branding })
    const status = await manager.status()
    expect(status.managed).toBe(false)
    expect(status.currentDataDir).toBe(process.env.LITTLESHEEP_DATA_DIR)
    await expect(manager.requestMigration(targetDir)).rejects.toThrow('环境变量管理')
  })
})

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, JSON.stringify(value, null, 2))
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fileTab(root: string, path: string): string {
  return `file:${encodeURIComponent(root)}|${encodeURIComponent(path)}`
}
