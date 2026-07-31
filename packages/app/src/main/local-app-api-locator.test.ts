import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  localAppApiLocatorPath,
  removeLocalAppApiLocator,
  writeLocalAppApiLocator,
} from './local-app-api-locator.js'

describe('Local App API runtime locator', () => {
  it('writes atomically and only removes the locator owned by the current token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-local-api-locator-'))
    const locator = {
      version: 1 as const,
      host: '127.0.0.1' as const,
      port: 43127,
      token: 'a'.repeat(43),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    try {
      const path = await writeLocalAppApiLocator(dataDir, locator)
      expect(path).toBe(localAppApiLocatorPath(dataDir))
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(locator)

      const replacement = { ...locator, port: 43128, token: 'b'.repeat(43) }
      await writeLocalAppApiLocator(dataDir, replacement)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement)

      await removeLocalAppApiLocator(dataDir, 'different-token')
      expect(existsSync(path)).toBe(true)

      await removeLocalAppApiLocator(dataDir, replacement.token)
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
