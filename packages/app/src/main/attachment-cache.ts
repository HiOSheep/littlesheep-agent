// Owns the bounded managed attachment cache, including its stable index,
// integrity checks, quotas and safe cleanup rules.
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import type {
  AttachmentRef,
  ManagedAttachmentResolution,
  ManagedAttachmentResolver,
} from './attachments.js'

const ATTACHMENT_CACHE_INDEX_VERSION = 1
const MAX_IMPORTED_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_CACHE_INDEX_BYTES = 4 * 1024 * 1024
const MAX_CACHE_INDEX_ENTRIES = 4096
const DEFAULT_MAX_CACHE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_CACHE_ENTRIES = 256
const DEFAULT_MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000
const IMAGE_ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg'])
const DOCUMENT_ATTACHMENT_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.docm', '.dotx', '.ppt', '.pptx', '.pptm', '.pps', '.ppsx',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.xltx',
])

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mimeType, extension]) => [extension, mimeType]),
)

interface AttachmentCacheEntry {
  id: string
  fileName: string
  originalName: string
  mimeType: string
  size: number
  contentHash: string
  createdAt: string
  lastAccessedAt: string
}

interface AttachmentCacheIndex {
  version: typeof ATTACHMENT_CACHE_INDEX_VERSION
  entries: Record<string, AttachmentCacheEntry>
}

export interface ManagedAttachmentCacheOptions {
  rootDir: string
  maxBytes?: number
  maxEntries?: number
  maxAgeMs?: number
  now?: () => number
}

export interface AttachmentCacheCleanupReport {
  removed: number
  missing: number
  conflicted: number
  retained: number
  retainedBytes: number
}

export interface AttachmentCacheStats {
  entries: number
  bytes: number
}

/**
 * Owns only files imported by LS into the dedicated attachment-cache root.
 * Cleanup is index-driven and verifies path, file type, size, and hash before unlinking.
 */
export class ManagedAttachmentCache implements ManagedAttachmentResolver {
  readonly rootDir: string
  readonly filesDir: string
  readonly indexPath: string

  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ManagedAttachmentCacheOptions) {
    this.rootDir = resolve(options.rootDir)
    this.filesDir = join(this.rootDir, 'files')
    this.indexPath = join(this.rootDir, 'index.json')
    this.maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_CACHE_BYTES)
    this.maxEntries = normalizeLimit(options.maxEntries, DEFAULT_MAX_CACHE_ENTRIES)
    this.maxAgeMs = normalizeLimit(options.maxAgeMs, DEFAULT_MAX_CACHE_AGE_MS)
    this.now = options.now ?? Date.now
  }

  async initialize(protectedIds: ReadonlySet<string> = new Set()): Promise<AttachmentCacheCleanupReport> {
    return this.exclusive(async () => {
      await this.ensureLayout()
      const index = await this.readIndex()
      const report = await this.cleanupIndex(index, protectedIds)
      await this.writeIndex(index)
      return report
    })
  }

  async importData(raw: Record<string, unknown>): Promise<AttachmentRef> {
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : ''
    if (!dataUrl) throw new Error('附件内容不能为空')

    const parsed = parseDataUrl(dataUrl)
    if (!parsed) throw new Error('附件内容格式无效')
    if (parsed.data.byteLength > MAX_IMPORTED_ATTACHMENT_BYTES) {
      throw new Error(`附件不能超过 ${MAX_IMPORTED_ATTACHMENT_BYTES} 字节`)
    }

    return this.exclusive(async () => {
      await this.ensureLayout()
      const index = await this.readIndex()
      const id = randomUUID()
      const requestedName = typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : `clipboard${EXT_BY_MIME[parsed.mimeType] ?? ''}`
      const fileName = buildManagedFileName(id, requestedName, parsed.mimeType)
      const filePath = this.resolveEntryPath(fileName)
      if (!filePath) throw new Error('无法创建受管附件路径')

      const contentHash = hashBuffer(parsed.data)
      const timestamp = new Date(this.now()).toISOString()
      const entry: AttachmentCacheEntry = {
        id,
        fileName,
        originalName: sanitizeDisplayName(requestedName),
        mimeType: parsed.mimeType,
        size: parsed.data.byteLength,
        contentHash,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
      }

      await writeBufferAtomically(filePath, parsed.data)
      index.entries[id] = entry
      try {
        await this.writeIndex(index)
      } catch (error) {
        delete index.entries[id]
        await unlink(filePath).catch(() => undefined)
        throw error
      }

      await this.cleanupIndex(index, new Set([id]))
      await this.writeIndex(index)
      return {
        path: filePath,
        name: entry.originalName,
        kind: inferAttachmentKind(filePath),
        mimeType: entry.mimeType,
        size: entry.size,
        cacheId: entry.id,
        contentHash: entry.contentHash,
        ownership: 'cache',
      }
    })
  }

  /** Copy an explicitly user-selected file into the verified managed cache. */
  async importFile(ref: AttachmentRef): Promise<AttachmentRef> {
    const sourcePath = resolve(ref.path)
    const before = await lstat(sourcePath)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('附件必须是普通文件，不能是符号链接')
    if (before.size > MAX_IMPORTED_ATTACHMENT_BYTES) {
      throw new Error(`附件不能超过 ${MAX_IMPORTED_ATTACHMENT_BYTES} 字节`)
    }
    const data = await readFile(sourcePath)
    const after = await lstat(sourcePath)
    if (!after.isFile()
      || after.isSymbolicLink()
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino) {
      throw new Error('读取附件时源文件发生变化，请重新选择')
    }
    const requestedName = sanitizeDisplayName(ref.name ?? basename(sourcePath))
    const mimeType = ref.mimeType
      ?? MIME_BY_EXT[extname(requestedName).toLowerCase()]
      ?? 'application/octet-stream'
    return this.exclusive(async () => {
      await this.ensureLayout()
      const index = await this.readIndex()
      const id = randomUUID()
      const fileName = buildManagedFileName(id, requestedName, mimeType)
      const filePath = this.resolveEntryPath(fileName)
      if (!filePath) throw new Error('无法创建受管附件路径')
      const timestamp = new Date(this.now()).toISOString()
      const entry: AttachmentCacheEntry = {
        id,
        fileName,
        originalName: requestedName,
        mimeType,
        size: data.byteLength,
        contentHash: hashBuffer(data),
        createdAt: timestamp,
        lastAccessedAt: timestamp,
      }
      await writeBufferAtomically(filePath, data)
      index.entries[id] = entry
      try {
        await this.cleanupIndex(index, new Set([id]))
        await this.writeIndex(index)
      } catch (error) {
        delete index.entries[id]
        await unlink(filePath).catch(() => undefined)
        throw error
      }
      return {
        path: filePath,
        name: entry.originalName,
        kind: ref.kind ?? inferAttachmentKind(filePath),
        mimeType: entry.mimeType,
        size: entry.size,
        cacheId: entry.id,
        contentHash: entry.contentHash,
        ownership: 'cache',
      }
    })
  }

  async resolve(ref: AttachmentRef): Promise<ManagedAttachmentResolution | undefined> {
    const cacheId = ref.cacheId?.trim()
    if (!cacheId) return undefined

    return this.exclusive(async () => {
      const index = await this.readIndex()
      const entry = index.entries[cacheId]
      if (!entry) return undefined
      const filePath = this.resolveEntryPath(entry.fileName)
      if (!filePath) return undefined
      const verification = await verifyManagedFile(filePath, entry)
      if (verification !== 'verified') return undefined

      entry.lastAccessedAt = new Date(this.now()).toISOString()
      await this.writeIndex(index)
      return {
        path: filePath,
        name: entry.originalName,
        kind: inferAttachmentKind(filePath),
        mimeType: entry.mimeType,
        size: entry.size,
        cacheId: entry.id,
        contentHash: entry.contentHash,
        ownership: 'cache',
      }
    })
  }

  async cleanup(): Promise<AttachmentCacheCleanupReport> {
    return this.exclusive(async () => {
      const index = await this.readIndex()
      const report = await this.cleanupIndex(index, new Set())
      await this.writeIndex(index)
      return report
    })
  }

  async stats(): Promise<AttachmentCacheStats> {
    return this.exclusive(async () => {
      const index = await this.readIndex()
      const entries = Object.values(index.entries)
      return {
        entries: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.size, 0),
      }
    })
  }

  private async cleanupIndex(
    index: AttachmentCacheIndex,
    protectedIds: ReadonlySet<string>,
  ): Promise<AttachmentCacheCleanupReport> {
    const entries = Object.values(index.entries)
    const candidates = new Set<string>()
    const cutoff = this.now() - this.maxAgeMs

    for (const entry of entries) {
      if (protectedIds.has(entry.id)) continue
      if (Date.parse(entry.lastAccessedAt) < cutoff) candidates.add(entry.id)
    }

    let projectedEntries = entries.length
    let projectedBytes = entries.reduce((total, entry) => total + entry.size, 0)
    for (const id of candidates) {
      const entry = index.entries[id]
      if (!entry) continue
      projectedEntries -= 1
      projectedBytes -= entry.size
    }
    const oldestFirst = [...entries].sort((left, right) => (
      Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt)
      || left.id.localeCompare(right.id)
    ))
    for (const entry of oldestFirst) {
      if (projectedEntries <= this.maxEntries && projectedBytes <= this.maxBytes) break
      if (protectedIds.has(entry.id) || candidates.has(entry.id)) continue
      candidates.add(entry.id)
      projectedEntries -= 1
      projectedBytes -= entry.size
    }

    let removed = 0
    let missing = 0
    let conflicted = 0
    for (const id of candidates) {
      const entry = index.entries[id]
      if (!entry) continue
      const filePath = this.resolveEntryPath(entry.fileName)
      if (!filePath) {
        delete index.entries[id]
        missing += 1
        continue
      }
      const verification = await verifyManagedFile(filePath, entry)
      if (verification === 'missing') {
        delete index.entries[id]
        missing += 1
        continue
      }
      if (verification !== 'verified') {
        conflicted += 1
        continue
      }
      try {
        await unlink(filePath)
        delete index.entries[id]
        removed += 1
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          delete index.entries[id]
          missing += 1
        } else {
          conflicted += 1
        }
      }
    }

    const retained = Object.values(index.entries)
    return {
      removed,
      missing,
      conflicted,
      retained: retained.length,
      retainedBytes: retained.reduce((total, entry) => total + entry.size, 0),
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true })
  }

  private async readIndex(): Promise<AttachmentCacheIndex> {
    await this.ensureLayout()
    let raw: string
    try {
      const info = await stat(this.indexPath)
      if (info.size > MAX_CACHE_INDEX_BYTES) throw new Error('attachment cache index is too large')
      raw = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyIndex()
      if (error instanceof Error && error.message === 'attachment cache index is too large') {
        await this.preserveCorruptIndex()
        return emptyIndex()
      }
      throw error
    }
    try {
      return parseIndex(JSON.parse(raw) as unknown)
    } catch {
      await this.preserveCorruptIndex()
      return emptyIndex()
    }
  }

  private async writeIndex(index: AttachmentCacheIndex): Promise<void> {
    await atomicWrite(this.indexPath, JSON.stringify(index, null, 2))
  }

  private async preserveCorruptIndex(): Promise<void> {
    const backupPath = join(this.rootDir, `index.corrupt-${this.now()}-${randomUUID().slice(0, 8)}.json`)
    await copyFile(this.indexPath, backupPath).catch(() => undefined)
  }

  private resolveEntryPath(fileName: string): string | undefined {
    if (!isSafeFileName(fileName)) return undefined
    const target = resolve(this.filesDir, fileName)
    return isWithin(this.filesDir, target) ? target : undefined
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

function emptyIndex(): AttachmentCacheIndex {
  return { version: ATTACHMENT_CACHE_INDEX_VERSION, entries: {} }
}

function parseIndex(value: unknown): AttachmentCacheIndex {
  if (!value || typeof value !== 'object') throw new Error('attachment cache index must be an object')
  const raw = value as Record<string, unknown>
  if (raw.version !== ATTACHMENT_CACHE_INDEX_VERSION) throw new Error('unsupported attachment cache index version')
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    throw new Error('attachment cache entries must be an object')
  }
  const sourceEntries = Object.entries(raw.entries as Record<string, unknown>)
  if (sourceEntries.length > MAX_CACHE_INDEX_ENTRIES) throw new Error('attachment cache index has too many entries')

  const entries: Record<string, AttachmentCacheEntry> = {}
  for (const [id, candidate] of sourceEntries) {
    const entry = parseEntry(id, candidate)
    entries[id] = entry
  }
  return { version: ATTACHMENT_CACHE_INDEX_VERSION, entries }
}

function parseEntry(id: string, value: unknown): AttachmentCacheEntry {
  if (!value || typeof value !== 'object') throw new Error(`invalid attachment cache entry: ${id}`)
  const raw = value as Record<string, unknown>
  if (raw.id !== id || !isUuid(id)) throw new Error(`invalid attachment cache id: ${id}`)
  const fileName = readNonEmptyString(raw.fileName)
  const originalName = readNonEmptyString(raw.originalName)
  const mimeType = readNonEmptyString(raw.mimeType)
  const contentHash = readNonEmptyString(raw.contentHash)
  const createdAt = readIsoDate(raw.createdAt)
  const lastAccessedAt = readIsoDate(raw.lastAccessedAt)
  const size = typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size >= 0
    ? raw.size
    : undefined
  if (!fileName || !isSafeFileName(fileName) || !originalName || !mimeType || size === undefined) {
    throw new Error(`invalid attachment cache metadata: ${id}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(contentHash ?? '')) throw new Error(`invalid attachment cache hash: ${id}`)
  if (!createdAt || !lastAccessedAt) throw new Error(`invalid attachment cache timestamp: ${id}`)
  return { id, fileName, originalName, mimeType, size, contentHash: contentHash!, createdAt, lastAccessedAt }
}

async function verifyManagedFile(
  filePath: string,
  entry: AttachmentCacheEntry,
): Promise<'verified' | 'missing' | 'conflict'> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size) return 'conflict'
    const contentHash = hashBuffer(await readFile(filePath))
    return contentHash === entry.contentHash ? 'verified' : 'conflict'
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? 'missing' : 'conflict'
  }
}

async function writeBufferAtomically(targetPath: string, data: Buffer): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tempPath, data, { flag: 'wx' })
    await rename(tempPath, targetPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(dataUrl)
  if (!match) return null
  const mimeType = (match[1] || 'application/octet-stream').toLowerCase()
  const payload = match[3] ?? ''
  try {
    return {
      mimeType,
      data: match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
    }
  } catch {
    return null
  }
}

function buildManagedFileName(id: string, name: string, mimeType: string): string {
  const fallbackExt = EXT_BY_MIME[mimeType] ?? ''
  const base = sanitizeFileName(basename(name || `attachment${fallbackExt}`))
  const ext = extname(base) || fallbackExt
  const stem = sanitizeFileName(base.slice(0, ext ? -ext.length : undefined)) || 'attachment'
  return `${id}-${stem.slice(0, 80)}${ext}`
}

function sanitizeDisplayName(value: string): string {
  return sanitizeFileName(basename(value)).slice(0, 160) || 'attachment'
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
}

function inferAttachmentKind(filePath: string): AttachmentRef['kind'] {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_ATTACHMENT_EXTS.has(ext)) return 'image'
  if (DOCUMENT_ATTACHMENT_EXTS.has(ext)) return 'document'
  return 'file'
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

function isSafeFileName(value: string): boolean {
  return !!value && basename(value) === value && !value.includes('/') && !value.includes('\\')
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readIsoDate(value: unknown): string | undefined {
  const text = readNonEmptyString(value)
  return text && Number.isFinite(Date.parse(text)) ? text : undefined
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}
