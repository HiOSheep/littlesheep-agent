import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedAttachmentCache } from './attachment-cache.js'
import { prepareRunAttachments } from './attachments.js'

function dataUrl(content: string, mimeType = 'text/plain'): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`
}

describe('ManagedAttachmentCache', () => {
  it('imports into the dedicated cache and restores a verified entry after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-cache-'))
    try {
      const rootDir = join(dir, 'attachment-cache')
      const cache = new ManagedAttachmentCache({ rootDir })
      await cache.initialize()
      const ref = await cache.importData({ name: 'notes.txt', dataUrl: dataUrl('hello') })

      expect(ref.path.startsWith(rootDir)).toBe(true)
      expect(ref.path).not.toContain(join(dir, 'workplace'))
      expect(ref).toMatchObject({
        name: 'notes.txt',
        ownership: 'cache',
        size: 5,
      })
      expect(ref.cacheId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(ref.contentHash).toMatch(/^[a-f0-9]{64}$/u)

      const restarted = new ManagedAttachmentCache({ rootDir })
      await restarted.initialize()
      const prepared = await prepareRunAttachments([ref], { managedCache: restarted })
      expect(prepared[0]).toMatchObject({
        path: ref.path,
        ownership: 'cache',
        contentHash: ref.contentHash,
        contentState: 'uninspected',
      })
      expect(readFileSync(ref.path, 'utf8')).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies selected files into managed storage and preserves checkpoint-referenced entries during startup cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-selected-'))
    let now = Date.UTC(2026, 0, 1)
    try {
      const source = join(dir, 'selected.txt')
      writeFileSync(source, 'selected source', 'utf8')
      const rootDir = join(dir, 'attachment-cache')
      const cache = new ManagedAttachmentCache({ rootDir, maxAgeMs: 100, now: () => now })
      await cache.initialize()
      const managed = await cache.importFile({ path: source, name: 'selected.txt', kind: 'file' })
      writeFileSync(source, 'changed source', 'utf8')
      expect(readFileSync(managed.path, 'utf8')).toBe('selected source')

      now += 1_000
      const restarted = new ManagedAttachmentCache({ rootDir, maxAgeMs: 100, now: () => now })
      const report = await restarted.initialize(new Set([managed.cacheId!]))
      expect(report).toMatchObject({ removed: 0, retained: 1 })
      await expect(restarted.resolve(managed)).resolves.toMatchObject({
        cacheId: managed.cacheId,
        contentHash: managed.contentHash,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes only expired indexed files and preserves workplace and unindexed files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-clean-'))
    let now = Date.UTC(2026, 0, 1)
    try {
      const rootDir = join(dir, 'attachment-cache')
      const workplace = join(dir, 'workplace')
      mkdirSync(workplace, { recursive: true })
      const cache = new ManagedAttachmentCache({ rootDir, maxAgeMs: 100, now: () => now })
      await cache.initialize()
      const managed = await cache.importData({ name: 'managed.txt', dataUrl: dataUrl('managed') })
      const userFile = join(workplace, 'user-file.txt')
      const unindexed = join(cache.filesDir, 'user-unindexed.txt')
      writeFileSync(userFile, 'user', 'utf8')
      writeFileSync(unindexed, 'unindexed', 'utf8')

      now += 1000
      const report = await cache.cleanup()

      expect(report).toMatchObject({ removed: 1, conflicted: 0, retained: 0 })
      expect(existsSync(managed.path)).toBe(false)
      expect(readFileSync(userFile, 'utf8')).toBe('user')
      expect(readFileSync(unindexed, 'utf8')).toBe('unindexed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not delete a managed path when the file no longer matches its recorded hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-conflict-'))
    let now = Date.UTC(2026, 0, 1)
    try {
      const cache = new ManagedAttachmentCache({
        rootDir: join(dir, 'attachment-cache'),
        maxAgeMs: 100,
        now: () => now,
      })
      await cache.initialize()
      const managed = await cache.importData({ name: 'managed.txt', dataUrl: dataUrl('original') })
      writeFileSync(managed.path, 'changed by someone else', 'utf8')

      now += 1000
      const report = await cache.cleanup()

      expect(report).toMatchObject({ removed: 0, conflicted: 1, retained: 1 })
      expect(readFileSync(managed.path, 'utf8')).toBe('changed by someone else')
      await expect(cache.resolve(managed)).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces a bounded LRU entry quota without removing the newly imported file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-quota-'))
    let now = Date.UTC(2026, 0, 1)
    try {
      const cache = new ManagedAttachmentCache({
        rootDir: join(dir, 'attachment-cache'),
        maxEntries: 1,
        now: () => now,
      })
      await cache.initialize()
      const first = await cache.importData({ name: 'first.txt', dataUrl: dataUrl('first') })
      now += 1000
      const second = await cache.importData({ name: 'second.txt', dataUrl: dataUrl('second') })

      expect(existsSync(first.path)).toBe(false)
      expect(existsSync(second.path)).toBe(true)
      await expect(cache.stats()).resolves.toEqual({ entries: 1, bytes: 6 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('quarantines an invalid traversal index without deleting the outside file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-traversal-'))
    try {
      const rootDir = join(dir, 'attachment-cache')
      mkdirSync(rootDir, { recursive: true })
      const outside = join(dir, 'outside.txt')
      writeFileSync(outside, 'outside', 'utf8')
      const id = '4f0389ea-7c4d-4f5f-a668-f9da360ae69e'
      writeFileSync(join(rootDir, 'index.json'), JSON.stringify({
        version: 1,
        entries: {
          [id]: {
            id,
            fileName: '../outside.txt',
            originalName: 'outside.txt',
            mimeType: 'text/plain',
            size: 7,
            contentHash: '0'.repeat(64),
            createdAt: '2026-01-01T00:00:00.000Z',
            lastAccessedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }), 'utf8')

      const cache = new ManagedAttachmentCache({ rootDir })
      await cache.initialize()

      expect(readFileSync(outside, 'utf8')).toBe('outside')
      expect((await cache.stats()).entries).toBe(0)
      expect(existsSync(join(rootDir, 'index.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a forged or stale cache id instead of treating it as an external file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-stale-'))
    try {
      const external = join(dir, 'external.txt')
      writeFileSync(external, 'external', 'utf8')
      const cache = new ManagedAttachmentCache({ rootDir: join(dir, 'attachment-cache') })
      await cache.initialize()

      await expect(prepareRunAttachments([{
        path: external,
        name: 'external.txt',
        cacheId: '4f0389ea-7c4d-4f5f-a668-f9da360ae69e',
      }], { managedCache: cache })).rejects.toThrow('受管附件已失效')
      expect(readFileSync(external, 'utf8')).toBe('external')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
