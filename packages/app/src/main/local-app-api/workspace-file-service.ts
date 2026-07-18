// Safe workspace directory listing, preview and text-save operations.

import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import {
  WORKSPACE_MARKDOWN_EXTS,
  classifyWorkspaceFileSurface,
  previewLanguageForWorkspaceFile,
} from '../workspace-file-routing.js'
import { HttpError } from './http.js'
import { isPathInsideOrSame } from './workspace-support.js'
import { previewWorkspaceOfficeFile } from '../workspace-office-preview.js'

const MAX_WORKSPACE_DIR_ENTRIES = 320
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
export const MAX_TEXT_SAVE_BYTES = 1024 * 1024
const TEXT_SNIFF_BYTES = 64 * 1024
const HEAVY_WORKSPACE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'target',
])

export async function listWorkspaceDirectory(root: string, target: string) {
  const info = await lstat(target)
  if (!info.isDirectory()) throw new HttpError(400, 'workspace path is not a directory')
  const rawEntries = await readdir(target, { withFileTypes: true })
  let hiddenCount = 0
  const visibleEntries = rawEntries
    .filter((entry) => {
      if (entry.isSymbolicLink()) {
        hiddenCount += 1
        return false
      }
      if (entry.isDirectory() && HEAVY_WORKSPACE_DIRS.has(entry.name.toLowerCase())) {
        hiddenCount += 1
        return false
      }
      return true
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  const limited = visibleEntries.slice(0, MAX_WORKSPACE_DIR_ENTRIES)
  const entries = await Promise.all(limited.map(async (entry) => {
    const itemPath = resolve(target, entry.name)
    if (!isPathInsideOrSame(root, itemPath)) return null
    const itemInfo = await lstat(itemPath).catch(() => null)
    if (!itemInfo || itemInfo.isSymbolicLink()) return null
    const kind = itemInfo.isDirectory() ? 'directory' : 'file'
    return {
      name: entry.name,
      path: itemPath,
      relativePath: relative(root, itemPath),
      kind,
      size: kind === 'file' ? itemInfo.size : undefined,
      modifiedAt: itemInfo.mtimeMs,
    }
  }))
  return {
    root,
    path: target,
    relativePath: relative(root, target),
    entries: entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    truncated: visibleEntries.length > limited.length,
    hiddenCount,
  }
}

export async function previewWorkspaceFile(root: string, target: string) {
  const info = await stat(target)
  if (!info.isFile()) throw new HttpError(400, 'workspace path is not a file')
  const name = basename(target)
  const lowerName = name.toLowerCase()
  const ext = extname(lowerName)
  const base = {
    path: target,
    name,
    relativePath: relative(root, target),
    size: info.size,
    modifiedAt: info.mtimeMs,
  }
  const surface = classifyWorkspaceFileSurface(lowerName, ext)
  if (surface === 'imagePreview') return { ...base, kind: 'image' as const }
  if (surface === 'pdfPreview') return { ...base, kind: 'pdf' as const }
  if (surface === 'documentCard') {
    return { ...base, ...await previewWorkspaceOfficeFile(target, ext) }
  }
  if (info.size > MAX_TEXT_PREVIEW_BYTES) {
    return {
      ...base,
      kind: 'unsupported' as const,
      reason: `文件超过 ${Math.round(MAX_TEXT_PREVIEW_BYTES / 1024)} KB，当前阶段不内联预览。`,
    }
  }
  if (surface === 'builtinEditor' && WORKSPACE_MARKDOWN_EXTS.has(ext)) {
    return { ...base, kind: 'markdown' as const, content: await readUtf8Preview(target) }
  }
  if (surface === 'builtinEditor') {
    return {
      ...base,
      kind: 'text' as const,
      language: previewLanguageForWorkspaceFile(lowerName, ext),
      content: await readUtf8Preview(target),
    }
  }
  const detectedTextContent = await readUtf8PreviewIfLikely(target)
  if (detectedTextContent !== null) {
    return {
      ...base,
      kind: 'text' as const,
      language: previewLanguageForWorkspaceFile(lowerName, ext),
      content: detectedTextContent,
    }
  }
  return {
    ...base,
    kind: 'unsupported' as const,
    reason: '这个文件看起来不是文本或代码文件，可以用系统默认应用打开。',
  }
}

export async function saveWorkspaceTextFile(root: string, target: string, body: Record<string, unknown>) {
  const content = typeof body.content === 'string' ? body.content : null
  if (content === null) throw new HttpError(400, 'content must be a string')
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_SAVE_BYTES) {
    throw new HttpError(413, `文件超过 ${Math.round(MAX_TEXT_SAVE_BYTES / 1024)} KB，当前阶段不支持内置保存。`)
  }
  const info = await lstat(target)
  if (info.isSymbolicLink()) throw new HttpError(403, 'workspace save does not follow symbolic links')
  if (!info.isFile()) throw new HttpError(400, 'workspace path is not a file')
  const lowerName = basename(target).toLowerCase()
  const ext = extname(lowerName)
  const surface = classifyWorkspaceFileSurface(lowerName, ext)
  if (
    surface !== 'builtinEditor'
    && (surface !== 'sniffText' || info.size > MAX_TEXT_PREVIEW_BYTES || await readUtf8PreviewIfLikely(target) === null)
  ) {
    throw new HttpError(415, '当前阶段只支持保存文本或 Markdown 文件。')
  }
  const expectedModifiedAt = typeof body.expectedModifiedAt === 'number' ? body.expectedModifiedAt : undefined
  if (expectedModifiedAt !== undefined && info.mtimeMs > expectedModifiedAt + 1) {
    throw new HttpError(409, '文件已被外部修改。请刷新预览后再保存，避免覆盖新的内容。')
  }
  await writeFile(target, content, 'utf8')
  return previewWorkspaceFile(root, target)
}

async function readUtf8Preview(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\u0000/g, '�')
}

async function readUtf8PreviewIfLikely(path: string): Promise<string | null> {
  const buffer = await readFile(path)
  return looksLikeTextBuffer(buffer) ? buffer.toString('utf8') : null
}

function looksLikeTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  const sample = buffer.subarray(0, Math.min(TEXT_SNIFF_BYTES, buffer.length))
  let suspiciousControlBytes = 0
  for (const byte of sample) {
    if (byte === 0) return false
    const isTextControl = byte === 9 || byte === 10 || byte === 12 || byte === 13
    if (byte < 32 && !isTextControl) suspiciousControlBytes += 1
  }
  if (suspiciousControlBytes / sample.length > 0.02) return false
  const decoded = sample.toString('utf8')
  const replacementChars = decoded.split('\uFFFD').length - 1
  return replacementChars / Math.max(1, decoded.length) <= 0.01
}
