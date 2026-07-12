import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { RunAttachment } from '@littlesheep/types'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'

const MAX_ATTACHMENT_PREVIEW_CHARS = 8000
const MAX_EXTRACTED_DOCUMENT_CHARS = 24000
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_WORKBOOK_SHEETS = 5
const MAX_WORKBOOK_ROWS_PER_SHEET = 120

const TEXT_ATTACHMENT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.xml', '.py', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.ps1',
  '.bat', '.sql', '.log',
])
const IMAGE_ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg'])
const DOCUMENT_ATTACHMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'])
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
}
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
const MAX_IMPORTED_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface AttachmentRef {
  path: string
  name?: string
  kind?: 'image' | 'document' | 'file'
  size?: number
}

interface PreparedAttachment extends RunAttachment {
  extractedText?: string
  extractionNote?: string
}

export async function classifyAttachment(filePath: string): Promise<AttachmentRef> {
  let size: number | undefined
  try {
    size = (await stat(filePath)).size
  } catch {
    size = undefined
  }
  return {
    path: filePath,
    name: basename(filePath),
    kind: inferAttachmentKind(filePath),
    size,
  }
}

export async function importAttachmentData(workplaceDir: string, raw: Record<string, unknown>): Promise<AttachmentRef> {
  const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : ''
  if (!dataUrl) throw new Error('attachment dataUrl is required')

  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new Error('attachment dataUrl is invalid')
  if (parsed.data.byteLength > MAX_IMPORTED_ATTACHMENT_BYTES) {
    throw new Error(`attachment is larger than ${MAX_IMPORTED_ATTACHMENT_BYTES} bytes`)
  }

  const importDir = join(workplaceDir, 'attachments')
  await mkdir(importDir, { recursive: true })
  const requestedName = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : `clipboard${EXT_BY_MIME[parsed.mimeType] ?? ''}`
  const fileName = buildImportedAttachmentName(requestedName, parsed.mimeType)
  const filePath = join(importDir, fileName)
  await writeFile(filePath, parsed.data)
  return classifyAttachment(filePath)
}

export function parseAttachments(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): AttachmentRef | null => {
      if (typeof item === 'string') return { path: item }
      if (!item || typeof item !== 'object') return null
      const raw = item as Record<string, unknown>
      const filePath = typeof raw.path === 'string' ? raw.path.trim() : ''
      if (!filePath) return null
      const kind = raw.kind === 'image' || raw.kind === 'document' || raw.kind === 'file'
        ? raw.kind
        : inferAttachmentKind(filePath)
      return {
        path: filePath,
        name: typeof raw.name === 'string' ? raw.name : basename(filePath),
        kind,
        size: typeof raw.size === 'number' ? raw.size : undefined,
      }
    })
    .filter((item): item is AttachmentRef => item !== null)
}

export async function prepareRunAttachments(attachments: AttachmentRef[]): Promise<RunAttachment[]> {
  const prepared: PreparedAttachment[] = []
  for (const attachment of attachments) {
    const kind = attachment.kind ?? inferAttachmentKind(attachment.path)
    const item: PreparedAttachment = {
      path: attachment.path,
      name: attachment.name ?? basename(attachment.path),
      kind,
      size: attachment.size,
    }
    if (kind === 'image') {
      const data = await readImageDataUrl(attachment.path)
      item.mimeType = data.mimeType
      item.dataUrl = data.dataUrl
      if (!data.dataUrl && data.reason) item.extractionNote = data.reason
    } else {
      const extracted = await extractAttachmentText(attachment.path)
      item.extractedText = extracted.text
      item.extractionNote = extracted.note
    }
    prepared.push(item)
  }
  return prepared
}

export async function composeRunText(text: string, attachments: RunAttachment[]): Promise<string> {
  if (attachments.length === 0) return text
  const lines = [
    text,
    '',
    '---',
    'User selected these local attachments. Use extracted text and paths directly when useful. Image attachments are also included as model image inputs when supported.',
  ]
  for (const attachment of attachments as PreparedAttachment[]) {
    const filePath = attachment.path
    let size = attachment.size
    try {
      size = (await stat(filePath)).size
    } catch {
      // Keep the path in context even if stat fails; the agent can report the issue.
    }
    const visual = attachment.dataUrl ? ', image input attached' : ''
    lines.push(`- ${attachment.name ?? basename(filePath)} (${attachment.kind}, ${size ?? 'unknown'} bytes${visual}): ${filePath}`)
    if (attachment.extractionNote) {
      lines.push(`  Note: ${attachment.extractionNote}`)
    }
    const preview = attachment.extractedText ?? await readTextPreview(filePath)
    if (preview) {
      lines.push('  Extracted text:')
      lines.push(indent(preview, '    '))
    }
  }
  return lines.join('\n')
}

async function extractAttachmentText(filePath: string): Promise<{ text?: string; note?: string }> {
  const ext = extname(filePath).toLowerCase()
  if (TEXT_ATTACHMENT_EXTS.has(ext)) {
    return { text: await readTextPreview(filePath) ?? undefined }
  }
  if (ext === '.docx') {
    return extractDocxText(filePath)
  }
  if (ext === '.xlsx' || ext === '.xls') {
    return extractWorkbookText(filePath)
  }
  if (ext === '.pdf') {
    return { note: 'PDF text extraction is not enabled yet; the file path is available for tool-based follow-up.' }
  }
  if (ext === '.doc' || ext === '.ppt' || ext === '.pptx') {
    return { note: `${ext.slice(1).toUpperCase()} text extraction is not enabled yet; the file path is available for tool-based follow-up.` }
  }
  return {}
}

async function extractDocxText(filePath: string): Promise<{ text?: string; note?: string }> {
  try {
    const result = await mammoth.extractRawText({ path: filePath })
    const text = clip(result.value.trim(), MAX_EXTRACTED_DOCUMENT_CHARS)
    const note = result.messages.length > 0 ? `DOCX extracted with ${result.messages.length} parser warning(s).` : undefined
    return { text: text || undefined, note }
  } catch (err) {
    return { note: `DOCX extraction failed: ${(err as Error).message}` }
  }
}

async function extractWorkbookText(filePath: string): Promise<{ text?: string; note?: string }> {
  try {
    const workbook = XLSX.readFile(filePath, { cellDates: true })
    const sheetNames = workbook.SheetNames.slice(0, MAX_WORKBOOK_SHEETS)
    const chunks: string[] = []
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, raw: false })
      const limited = rows
        .slice(0, MAX_WORKBOOK_ROWS_PER_SHEET)
        .map((row) => row.map((cell) => String(cell ?? '').trim()).join('\t'))
        .filter((row) => row.trim().length > 0)
      chunks.push(`# Sheet: ${sheetName}\n${limited.join('\n')}`)
    }
    const skippedSheets = workbook.SheetNames.length > sheetNames.length
      ? ` Workbook has ${workbook.SheetNames.length} sheets; only first ${sheetNames.length} were extracted.`
      : ''
    const text = clip(chunks.join('\n\n').trim(), MAX_EXTRACTED_DOCUMENT_CHARS)
    return {
      text: text || undefined,
      note: skippedSheets.trim() || undefined,
    }
  } catch (err) {
    return { note: `Workbook extraction failed: ${(err as Error).message}` }
  }
}

async function readImageDataUrl(filePath: string): Promise<{ mimeType?: string; dataUrl?: string; reason?: string }> {
  const ext = extname(filePath).toLowerCase()
  const mimeType = IMAGE_MIME_BY_EXT[ext]
  if (!mimeType) return {}
  try {
    const info = await stat(filePath)
    if (info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      return { mimeType, reason: `Image is larger than ${MAX_IMAGE_ATTACHMENT_BYTES} bytes; only the file path was attached.` }
    }
    const data = await readFile(filePath)
    return { mimeType, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` }
  } catch (err) {
    return { mimeType, reason: `Image attachment could not be read: ${(err as Error).message}` }
  }
}

async function readTextPreview(filePath: string): Promise<string | null> {
  if (!TEXT_ATTACHMENT_EXTS.has(extname(filePath).toLowerCase())) return null
  try {
    const raw = await readFile(filePath, 'utf8')
    return clip(raw, MAX_ATTACHMENT_PREVIEW_CHARS)
  } catch {
    return null
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mimeType = (match[1] || 'application/octet-stream').toLowerCase()
  const isBase64 = !!match[2]
  const payload = match[3] ?? ''
  try {
    return {
      mimeType,
      data: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
    }
  } catch {
    return null
  }
}

function buildImportedAttachmentName(name: string, mimeType: string): string {
  const fallbackExt = EXT_BY_MIME[mimeType] ?? ''
  const base = sanitizeFileName(basename(name || `attachment${fallbackExt}`))
  const ext = extname(base) || fallbackExt
  const stem = sanitizeFileName(base.slice(0, ext ? -ext.length : undefined)) || 'attachment'
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${stem.slice(0, 80)}${ext}`
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferAttachmentKind(filePath: string): RunAttachment['kind'] {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_ATTACHMENT_EXTS.has(ext)) return 'image'
  if (DOCUMENT_ATTACHMENT_EXTS.has(ext)) return 'document'
  return 'file'
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[extracted text truncated]` : value
}

function indent(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n')
}
