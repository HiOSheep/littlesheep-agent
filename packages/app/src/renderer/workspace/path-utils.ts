// Extension workspace panels, files, terminal, artifacts, and view helpers.
import {
  type AttachmentRef,
  type RuntimeState,
  type WorkspacePreview
} from '../api'
import { workspaceLanguageLabel } from '../../shared/workspace-languages'
import { WorkspaceArtifactRef } from './types'


export function shortPath(path: string, workplace: string): string {
  if (isSamePath(path, workplace)) return compactPath(workplace)
  return compactPath(path)
}


export function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return `${parts.at(-2)}\\${parts.at(-1)}`
}


export function workspaceTitle(path: string, workplace: string): string {
  return isSamePath(path, workplace) ? `LittleSheep workplace: ${workplace}` : path
}


export function workspaceBreadcrumbs(root: string, path: string): string[] {
  const rootName = lastPathSegment(root) || compactPath(root)
  const normalizedRoot = normalizePathForCompare(root)
  const normalizedPath = normalizePathForCompare(path)
  if (!normalizedPath.startsWith(normalizedRoot)) return [rootName, lastPathSegment(path)].filter(Boolean)
  const relative = path.slice(root.length).replace(/^[\\/]+/, '')
  const parts = relative.split(/[\\/]/).filter(Boolean)
  return [rootName, ...parts].slice(-5)
}


export function attachmentToArtifact(file: AttachmentRef): WorkspaceArtifactRef {
  return {
    path: file.path,
    name: file.name ?? lastPathSegment(file.path),
    action: 'attached',
  }
}


export function resolveWorkspacePreviewRoot(path: string, runtime: RuntimeState | null, fallbackRoot: string): string {
  const candidates = [runtime?.workspace, runtime?.workplace, fallbackRoot].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    if (isPathInsideOrSameClient(path, candidate)) return candidate
  }
  return directoryPath(path) || fallbackRoot
}


export function isPathInsideOrSameClient(path: string, root: string): boolean {
  const normalizedPath = normalizePathForCompare(path)
  const normalizedRoot = normalizePathForCompare(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`)
}


export function isSamePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}


export function normalizePathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}


export function directoryPath(path: string): string {
  const normalized = path.replace(/\//g, '\\').replace(/[\\]+$/, '')
  const index = normalized.lastIndexOf('\\')
  if (index <= 0) return ''
  return normalized.slice(0, index)
}


export function workspaceAncestorPaths(root: string, path: string): string[] {
  if (!root || !path || !isPathInsideOrSameClient(path, root) || isSamePath(path, root)) return []
  const ancestors: string[] = []
  let current = directoryPath(path)
  while (current && isPathInsideOrSameClient(current, root) && !isSamePath(current, root)) {
    ancestors.unshift(current)
    current = directoryPath(current)
  }
  return [root, ...ancestors]
}


export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}


export function inferAttachmentKind(name: string, mimeType = ''): AttachmentRef['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  const ext = extensionOf(name)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg'].includes(ext)) return 'image'
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document'
  return 'file'
}


export const WORKSPACE_EXTERNAL_EDITOR_BLOCKED_EXTS = new Set([
  'doc',
  'docx',
  'docm',
  'dot',
  'dotx',
  'ppt',
  'pptx',
  'pptm',
  'pps',
  'ppsx',
  'pot',
  'potx',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'xlt',
  'xltx',
  'odt',
  'odp',
  'ods',
])


export function shouldOfferExternalVSCode(preview: WorkspacePreview): boolean {
  if (preview.kind === 'image' || preview.kind === 'pdf') return false
  return !WORKSPACE_EXTERNAL_EDITOR_BLOCKED_EXTS.has(extensionOf(preview.name))
}


export function attachmentFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  const encoded = normalized
    .split('/')
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/')
  return `${prefix}${encoded}`
}


export function attachmentExtLabel(name: string): string {
  const ext = extensionOf(name)
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
}


export function extensionOf(name: string): string {
  const clean = lastPathSegment(name).toLowerCase()
  const index = clean.lastIndexOf('.')
  return index >= 0 ? clean.slice(index + 1) : ''
}


export function formatFileSize(size?: number): string {
  if (!size || size <= 0) return 'unknown size'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}


export function countEditorLines(text: string): number {
  if (!text) return 1
  return text.split(/\r\n|\r|\n/).length
}


export function detectEditorEol(text: string): string {
  return text.includes('\r\n') ? 'CRLF' : 'LF'
}


export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}


export function formatEditorLanguageLabel(language: string): string {
  return workspaceLanguageLabel(language === 'text' ? 'plaintext' : language)
}


export function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}


export function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
