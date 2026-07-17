// Resolves run-scoped attachment metadata and content under explicit ownership
// rules; payloads are never persisted into execution logs.
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentTool, AttachmentOwnership, RunAttachment } from '@littlesheep/types'
import type { AttachmentRef } from '../shared/attachment-contracts.js'
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
export type { AttachmentRef } from '../shared/attachment-contracts.js'

export interface ManagedAttachmentResolution extends AttachmentRef {
  cacheId: string
  contentHash: string
  ownership: 'cache'
}

export interface ManagedAttachmentResolver {
  resolve(ref: AttachmentRef): Promise<ManagedAttachmentResolution | undefined>
}

export interface PrepareRunAttachmentsOptions {
  managedCache?: ManagedAttachmentResolver
  workplaceDir?: string
  workspaceDir?: string
  projectId?: string
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
        mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
        size: typeof raw.size === 'number' ? raw.size : undefined,
        cacheId: typeof raw.cacheId === 'string' ? raw.cacheId.trim() || undefined : undefined,
      }
    })
    .filter((item): item is AttachmentRef => item !== null)
}

export async function prepareRunAttachments(
  attachments: AttachmentRef[],
  options: PrepareRunAttachmentsOptions = {},
): Promise<RunAttachment[]> {
  const prepared: RunAttachment[] = []
  for (const attachment of attachments) {
    let source = attachment
    let ownership = resolveAttachmentOwnership(attachment.path, options)
    let contentHash: string | undefined
    if (attachment.cacheId) {
      const managed = await options.managedCache?.resolve(attachment)
      if (!managed) throw new Error(`受管附件已失效，请重新添加：${attachment.name ?? basename(attachment.path)}`)
      source = managed
      ownership = 'cache'
      contentHash = managed.contentHash
    }

    const kind = source.kind ?? inferAttachmentKind(source.path)
    let size = source.size
    if (size === undefined) {
      try {
        size = (await stat(source.path)).size
      } catch {
        size = undefined
      }
    }
    const item: RunAttachment = {
      id: randomUUID(),
      path: source.path,
      name: source.name ?? basename(source.path),
      kind,
      mimeType: source.mimeType,
      size,
      contentHash,
      ownership,
      contentState: 'uninspected',
    }
    if (kind === 'image') {
      const data = await readImageDataUrl(source.path)
      item.mimeType = data.mimeType
      item.dataUrl = data.dataUrl
      if (!data.dataUrl && data.reason) item.extractionNote = data.reason
      item.contentState = data.dataUrl ? 'loaded' : 'unavailable'
    }
    prepared.push(item)
  }
  return prepared
}

export function createInspectAttachmentTool(attachments: RunAttachment[]): AgentTool | undefined {
  if (!attachments.some((attachment) => attachment.kind !== 'image')) return undefined
  return {
    name: 'inspect_attachment',
    description: 'Read one user-selected attachment by its manifest id. Use only when the task needs the file content.',
    inputSchema: {
      parse(input: unknown) {
        if (!input || typeof input !== 'object') throw new Error('attachment_id is required')
        const attachmentId = (input as Record<string, unknown>).attachment_id
        if (typeof attachmentId !== 'string' || !attachmentId.trim()) {
          throw new Error('attachment_id is required')
        }
        return { attachment_id: attachmentId.trim() }
      },
      jsonSchema: {
        type: 'object',
        properties: {
          attachment_id: {
            type: 'string',
            description: 'The attachment id shown in the current run attachment manifest.',
          },
        },
        required: ['attachment_id'],
        additionalProperties: false,
      },
    },
    execution: {
      concurrency: 'parallel',
      resources(input) {
        const attachmentId = input && typeof input === 'object'
          ? (input as Record<string, unknown>).attachment_id
          : undefined
        return typeof attachmentId === 'string' && attachmentId.trim()
          ? [{ key: `attachment:${attachmentId.trim()}`, mode: 'read' as const }]
          : []
      },
    },
    async execute(input, ctx) {
      const { attachment_id: attachmentId } = input as { attachment_id: string }
      const attachment = attachments.find((item) => item.id === attachmentId)
      if (!attachment) {
        return { callId: '', ok: false, error: `Attachment not found in this run: ${attachmentId}` }
      }
      if (ctx.signal?.aborted) {
        return { callId: '', ok: false, error: 'Attachment inspection aborted.' }
      }
      let loaded: RunAttachment
      try {
        loaded = await loadRunAttachmentContent(attachment, ctx.signal)
        Object.assign(attachment, loaded)
      } catch (err) {
        return { callId: '', ok: false, error: `Attachment inspection failed: ${(err as Error).message}` }
      }
      const header = [
        `Attachment [${attachmentId}] ${loaded.name ?? loaded.path}`,
        `Path: ${loaded.path}`,
        `State: ${loaded.contentState ?? 'unavailable'}`,
      ]
      if (loaded.extractionNote) header.push(`Note: ${loaded.extractionNote}`)
      if (loaded.extractedText?.trim()) header.push('', loaded.extractedText)
      return {
        callId: '',
        ok: true,
        output: header.join('\n'),
        meta: {
          attachmentId,
          contentState: loaded.contentState,
          contentAvailable: !!loaded.extractedText,
        },
      }
    },
  }
}

export async function loadRunAttachmentContent(
  attachment: RunAttachment,
  signal?: AbortSignal,
): Promise<RunAttachment> {
  if (attachment.contentState === 'loaded' || attachment.contentState === 'unavailable') {
    return attachment
  }
  if (signal?.aborted) throw new Error('Attachment inspection aborted.')
  if (attachment.kind === 'image') return attachment
  const extracted = await extractAttachmentText(attachment.path)
  if (signal?.aborted) throw new Error('Attachment inspection aborted.')
  return {
    ...attachment,
    extractedText: extracted.text,
    extractionNote: extracted.note,
    contentState: extracted.text ? 'loaded' : 'unavailable',
  }
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

function inferAttachmentKind(filePath: string): RunAttachment['kind'] {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_ATTACHMENT_EXTS.has(ext)) return 'image'
  if (DOCUMENT_ATTACHMENT_EXTS.has(ext)) return 'document'
  return 'file'
}

function resolveAttachmentOwnership(
  filePath: string,
  options: PrepareRunAttachmentsOptions,
): AttachmentOwnership {
  if (options.projectId && options.workspaceDir && isWithin(options.workspaceDir, filePath)) return 'project'
  if (options.workplaceDir && isWithin(options.workplaceDir, filePath)) return 'user_workplace'
  if (options.workspaceDir && isWithin(options.workspaceDir, filePath)) return 'user_workplace'
  return 'external'
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[extracted text truncated]` : value
}
