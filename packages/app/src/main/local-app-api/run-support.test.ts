import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionIndex } from '../session-index.js'
import { updateSessionIndex, withPersistedSessionPermissionMode } from './run-support.js'

describe('run permission mode continuity', () => {
  it('uses the persisted session mode when a partial run request omits it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', {
        title: 'Session',
        mode: 'full',
        scope: 'standalone',
        workspacePath: workplaceDir,
      })

      await expect(withPersistedSessionPermissionMode(sessionIndex, {
        sessionId: 'session-1',
        text: 'run',
      })).resolves.toMatchObject({ permissionMode: 'full' })

      await updateSessionIndex(sessionIndex, 'session-1', { sessionId: 'session-1' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'full' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('does not let a legacy coding behavior request overwrite the permission policy', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', { mode: 'restricted', scope: 'standalone' })
      await updateSessionIndex(sessionIndex, 'session-1', { mode: 'coding' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'restricted' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps the actual resolved mode when checkpoint completion updates the index', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', { mode: 'research', scope: 'standalone' })
      await updateSessionIndex(sessionIndex, 'session-1', { permissionMode: 'full' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'full' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
