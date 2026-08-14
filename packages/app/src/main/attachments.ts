// Resolves run-scoped attachment metadata and content under explicit ownership
// rules; payloads are never persisted into execution logs.
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentTool, AttachmentOwnership, RunAttachment } from '@littlesheep/types'
import type { CheckpointResourceResolver } from '@littlesheep/runner'
import type { AttachmentRef } from '../shared/attachment-contracts.js'

const MAX_ATTACHMENT_PREVIEW_CHARS = 8000
const MAX_EXTRACTED_DOCUMENT_CHARS = 24000
const MAX_REQUESTED_DOCUMENT_CHARS = 100000
const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024

const TEXT_ATTACHMENT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.xml', '.py', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.ps1',
  '.bat', '.sql', '.log',
])
const IMAGE_ATTACHMENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg'])
const DOCUMENT_ATTACHMENT_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.docm', '.dotx', '.ppt', '.pptx', '.pptm', '.pps', '.ppsx',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.xltx',
])
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
      cacheId: source.cacheId,
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

export interface CreateCheckpointResourceResolverOptions extends PrepareRunAttachmentsOptions {
  managedCache: ManagedAttachmentResolver
}

interface AttachmentReadSelection {
  pageStart?: number
  pageEnd?: number
  sheetNames?: string[]
  maxChars?: number
}

/** Rebuild only closed, trusted checkpoint resource recipes. */
export function createCheckpointResourceResolver(
  options: CreateCheckpointResourceResolverOptions,
): CheckpointResourceResolver {
  return async (checkpoint, current) => {
    const state = checkpoint.resumeState
    if (!state) throw new Error('checkpoint has no resumable resource state')
    const references = state.attachments ?? []
    if (references.length !== state.attachmentCount) {
      throw new Error('checkpoint attachment manifest is incomplete; reattach the original resources')
    }

    const currentAttachments = [...(current.attachments ?? [])]
    const restored: RunAttachment[] = []
    const consumedCurrentIds = new Set<string>()
    for (const reference of references) {
      const supplied = currentAttachments.find((attachment) => (
        attachment.contentHash === reference.contentHash
        && attachment.cacheId
        && !consumedCurrentIds.has(attachment.id ?? attachment.cacheId)
      ))
      let attachment: RunAttachment
      if (supplied) {
        attachment = structuredClone(supplied)
        consumedCurrentIds.add(supplied.id ?? supplied.cacheId!)
      } else {
        const prepared = await prepareRunAttachments([{
          path: reference.name,
          name: reference.name,
          kind: reference.kind,
          mimeType: reference.mimeType,
          size: reference.size,
          cacheId: reference.cacheId,
          contentHash: reference.contentHash,
          ownership: 'cache',
        }], options)
        attachment = prepared[0]!
      }
      if (attachment.cacheId !== reference.cacheId && attachment.contentHash !== reference.contentHash) {
        throw new Error(`checkpoint attachment identity conflict: ${reference.name}`)
      }
      if (attachment.contentHash !== reference.contentHash
        || attachment.kind !== reference.kind
        || (reference.size !== undefined && attachment.size !== reference.size)) {
        throw new Error(`checkpoint attachment failed integrity verification: ${reference.name}`)
      }
      attachment.id = reference.attachmentId
      restored.push(attachment)
    }

    const extraAttachments = currentAttachments.filter((attachment) => (
      !consumedCurrentIds.has(attachment.id ?? attachment.cacheId ?? '')
      && !restored.some((item) => item.contentHash && item.contentHash === attachment.contentHash)
    ))
    const attachments = [...restored, ...extraAttachments]
    const recipes = state.toolRecipes ?? []
    const additionalTools = (current.additionalTools ?? [])
      .filter((tool) => tool.name !== 'inspect_attachment')
    if (state.availableToolNames.includes('inspect_attachment')
      && !recipes.some((recipe) => recipe.factory === 'inspect_attachment')) {
      throw new Error('checkpoint inspect_attachment factory recipe is missing or incompatible')
    }
    if (recipes.some((recipe) => recipe.factory === 'inspect_attachment')) {
      const inspectAttachment = createInspectAttachmentTool(attachments)
      if (!inspectAttachment) {
        throw new Error('checkpoint inspect_attachment recipe has no restorable non-image attachment')
      }
      additionalTools.push(inspectAttachment)
    }
    return { attachments, additionalTools }
  }
}

export function createInspectAttachmentTool(attachments: RunAttachment[]): AgentTool | undefined {
  if (!attachments.some((attachment) => attachment.kind !== 'image')) return undefined
  return {
    name: 'inspect_attachment',
    description: 'Read one user-selected attachment by its manifest id. PDF page ranges and workbook sheet selection are available for bounded multi-part reads.',
    inputSchema: {
      parse(input: unknown) {
        if (!input || typeof input !== 'object') throw new Error('attachment_id is required')
        const raw = input as Record<string, unknown>
        const attachmentId = raw.attachment_id
        if (typeof attachmentId !== 'string' || !attachmentId.trim()) {
          throw new Error('attachment_id is required')
        }
        const pageStart = optionalPositiveInteger(raw.page_start, 'page_start')
        const pageEnd = optionalPositiveInteger(raw.page_end, 'page_end')
        if (pageStart && pageEnd && pageEnd < pageStart) {
          throw new Error('page_end must be greater than or equal to page_start')
        }
        const maxChars = optionalPositiveInteger(raw.max_chars, 'max_chars', MAX_REQUESTED_DOCUMENT_CHARS)
        let sheetNames: string[] | undefined
        if (raw.sheet_names !== undefined) {
          if (!Array.isArray(raw.sheet_names) || raw.sheet_names.length === 0 || raw.sheet_names.length > 100) {
            throw new Error('sheet_names must contain between 1 and 100 names')
          }
          sheetNames = raw.sheet_names.map((value) => {
            if (typeof value !== 'string' || !value.trim()) throw new Error('sheet_names must contain non-empty strings')
            return value.trim()
          })
        }
        return {
          attachment_id: attachmentId.trim(),
          ...(pageStart ? { page_start: pageStart } : {}),
          ...(pageEnd ? { page_end: pageEnd } : {}),
          ...(sheetNames ? { sheet_names: sheetNames } : {}),
          ...(maxChars ? { max_chars: maxChars } : {}),
        }
      },
      jsonSchema: {
        type: 'object',
        properties: {
          attachment_id: {
            type: 'string',
            description: 'The attachment id shown in the current run attachment manifest.',
          },
          page_start: {
            type: 'integer',
            minimum: 1,
            description: 'Optional first PDF page to read (1-based).',
          },
          page_end: {
            type: 'integer',
            minimum: 1,
            description: 'Optional last PDF page to read (inclusive).',
          },
          sheet_names: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1 },
            description: 'Optional workbook sheet names to read.',
          },
          max_chars: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_REQUESTED_DOCUMENT_CHARS,
            description: 'Maximum extracted characters for this part.',
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
      const parsed = input as {
        attachment_id: string
        page_start?: number
        page_end?: number
        sheet_names?: string[]
        max_chars?: number
      }
      const attachmentId = parsed.attachment_id
      const selection: AttachmentReadSelection = {
        pageStart: parsed.page_start,
        pageEnd: parsed.page_end,
        sheetNames: parsed.sheet_names,
        maxChars: parsed.max_chars,
      }
      const attachment = attachments.find((item) => item.id === attachmentId)
      if (!attachment) {
        return { callId: '', ok: false, error: `Attachment not found in this run: ${attachmentId}` }
      }
      if (ctx.signal?.aborted) {
        return { callId: '', ok: false, error: 'Attachment inspection aborted.' }
      }
      let loaded: RunAttachment
      try {
        loaded = await loadRunAttachmentContent(attachment, ctx.signal, selection)
        if (!hasAttachmentReadSelection(selection)) Object.assign(attachment, loaded)
      } catch (err) {
        return { callId: '', ok: false, error: `Attachment inspection failed: ${(err as Error).message}` }
      }
      const header = [
        `Attachment [${attachmentId}] ${loaded.name ?? loaded.path}`,
        `Path: ${loaded.path}`,
        `State: ${loaded.contentState ?? 'unavailable'}`,
      ]
      if (loaded.extractionNote) header.push(`Note: ${loaded.extractionNote}`)
      const extractedText = loaded.extractedText?.trim()
      const contentAvailable = loaded.contentState === 'loaded' && !!extractedText
      if (!contentAvailable) {
        return {
          callId: '',
          ok: false,
          error: [
            `Attachment content is unavailable: ${loaded.name ?? loaded.path}`,
            loaded.extractionNote ?? 'The attachment contains no readable text.',
          ].join('\n'),
          meta: {
            attachmentId,
            contentState: loaded.contentState ?? 'unavailable',
            contentAvailable: false,
          },
        }
      }
      header.push('', extractedText)
      return {
        callId: '',
        ok: true,
        output: header.join('\n'),
        meta: {
          attachmentId,
          contentState: loaded.contentState,
          contentAvailable: true,
        },
      }
    },
  }
}

export async function loadRunAttachmentContent(
  attachment: RunAttachment,
  signal?: AbortSignal,
  selection: AttachmentReadSelection = {},
): Promise<RunAttachment> {
  if (!hasAttachmentReadSelection(selection)
    && (attachment.contentState === 'loaded' || attachment.contentState === 'unavailable')) {
    return attachment
  }
  if (signal?.aborted) throw new Error('Attachment inspection aborted.')
  if (attachment.kind === 'image') return attachment
  const extracted = await extractAttachmentText(attachment.path, selection)
  if (signal?.aborted) throw new Error('Attachment inspection aborted.')
  return {
    ...attachment,
    extractedText: extracted.text,
    extractionNote: extracted.note,
    contentState: extracted.text ? 'loaded' : 'unavailable',
  }
}

async function extractAttachmentText(
  filePath: string,
  selection: AttachmentReadSelection = {},
): Promise<{ text?: string; note?: string }> {
  const ext = extname(filePath).toLowerCase()
  if (TEXT_ATTACHMENT_EXTS.has(ext)) {
    return { text: await readTextPreview(filePath, selection.maxChars) ?? undefined }
  }
  try {
    const { extractDocument, UnsupportedDocumentFormatError } = await import('@littlesheep/documents')
    const extracted = await extractDocument(filePath, {
      pageStart: selection.pageStart,
      pageEnd: selection.pageEnd,
      sheetNames: selection.sheetNames,
      maxChars: selection.maxChars ?? MAX_EXTRACTED_DOCUMENT_CHARS,
      maxSections: 50,
      maxRowsPerSheet: 120,
    })
    const notes = [...extracted.notes]
    if (extracted.metadata.pageCount) notes.unshift(`总页数：${extracted.metadata.pageCount}`)
    if (extracted.metadata.sheetCount) notes.unshift(`工作表数：${extracted.metadata.sheetCount}`)
    if (extracted.metadata.slideCount) notes.unshift(`幻灯片数：${extracted.metadata.slideCount}`)
    if (extracted.truncated && !notes.some((note) => note.includes('截断'))) {
      notes.push('内容已按附件读取预算截断。')
    }
    return {
      text: extracted.text || undefined,
      note: notes.join(' ') || undefined,
    }
  } catch (err) {
    if (isUnsupportedDocumentFormatError(err)) return { note: (err as Error).message }
    return { note: `文档解析失败：${(err as Error).message}` }
  }
}

function isUnsupportedDocumentFormatError(error: unknown): boolean {
  return error instanceof Error && error.name === 'UnsupportedDocumentFormatError'
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

async function readTextPreview(filePath: string, maxChars?: number): Promise<string | null> {
  if (!TEXT_ATTACHMENT_EXTS.has(extname(filePath).toLowerCase())) return null
  try {
    const raw = await readFile(filePath, 'utf8')
    return clip(raw, Math.min(maxChars ?? MAX_ATTACHMENT_PREVIEW_CHARS, MAX_ATTACHMENT_PREVIEW_CHARS))
  } catch {
    return null
  }
}

function optionalPositiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${field} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

function hasAttachmentReadSelection(selection: AttachmentReadSelection): boolean {
  return selection.pageStart !== undefined
    || selection.pageEnd !== undefined
    || selection.sheetNames !== undefined
    || selection.maxChars !== undefined
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
