// Extracts bounded, page-aware text and metadata from PDF files through PDF.js.
import { clipText } from './limits.js'
import { buildExtracted, splitParagraphs, type EffectiveReadLimits } from './read-shared.js'
import type { DocumentSection, ExtractDocumentOptions, ExtractedDocument } from './types.js'

const MAX_PDF_PAGES = 2_000

interface PdfTextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfTextContent {
  items: PdfTextItem[]
}

interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>
  cleanup(): void
}

interface PdfDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  getMetadata(): Promise<unknown>
  cleanup(): Promise<void>
  destroy(): Promise<void>
}

export async function extractPdf(
  buffer: Buffer,
  bytes: number,
  options: ExtractDocumentOptions,
  limits: EffectiveReadLimits,
): Promise<ExtractedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  })
  const pdf = await loadingTask.promise as unknown as PdfDocumentProxy
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF 共 ${pdf.numPages} 页，超过安全上限 ${MAX_PDF_PAGES} 页。`)
    }
    const start = clampPage(options.pageStart, 1, pdf.numPages)
    const requestedEnd = options.pageEnd === undefined ? pdf.numPages : options.pageEnd
    const end = clampPage(requestedEnd, start, pdf.numPages)
    const sectionEnd = Math.min(end, start + limits.maxSections - 1)
    const sections: DocumentSection[] = []
    const notes: string[] = []
    let remaining = limits.maxChars
    let truncated = sectionEnd < end

    for (let pageNumber = start; pageNumber <= sectionEnd && remaining > 0; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const clipped = clipText(pdfItemsToText(content.items), remaining)
        remaining -= clipped.value.length
        if (clipped.truncated) truncated = true
        sections.push({ title: `第 ${pageNumber} 页`, paragraphs: splitParagraphs(clipped.value) })
      } finally {
        page.cleanup()
      }
    }
    if (sections.every((section) => (section.paragraphs ?? []).length === 0)) {
      notes.push('未发现可提取文本；这可能是扫描版 PDF，需要 OCR 或逐页图像识别。')
    }
    if (start > 1 || end < pdf.numPages) notes.push(`仅读取第 ${start}-${end} 页。`)
    if (truncated) notes.push('内容已按页数、分段数或字符预算截断。')
    const title = await readPdfTitle(pdf)
    if (title) notes.unshift(`标题：${title}`)
    return buildExtracted('pdf', sections, truncated, notes, { bytes, pageCount: pdf.numPages })
  } finally {
    await pdf.cleanup().catch(() => undefined)
    await pdf.destroy().catch(() => undefined)
  }
}

function pdfItemsToText(items: PdfTextItem[]): string {
  let text = ''
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    text += item.str
    if (item.hasEOL) text += '\n'
  }
  return text.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

async function readPdfTitle(pdf: PdfDocumentProxy): Promise<string> {
  const metadata = await pdf.getMetadata().catch(() => undefined)
  const info = metadata && typeof metadata === 'object' && 'info' in metadata
    ? (metadata as { info?: unknown }).info
    : undefined
  const value = info && typeof info === 'object' && 'Title' in info
    ? (info as { Title?: unknown }).Title
    : undefined
  return typeof value === 'string' ? value.trim() : ''
}

function clampPage(value: number | undefined, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return minimum
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}
