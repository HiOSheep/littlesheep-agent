// Extracts bounded content from DOCX, spreadsheet, and PPTX container formats.
import mammoth from 'mammoth'
import { MAX_CREATE_COLUMNS, clipText } from './limits.js'
import {
  boundedZipEntryNames,
  extractDrawingMlTextRuns,
  loadOfficeZip,
  MAX_ZIP_ENTRIES,
  readBoundedZipText,
  readWorkbookSections,
  slideNumber,
} from './read-office-shared.js'
import { buildExtracted, splitParagraphs, type EffectiveReadLimits } from './read-shared.js'
import type { DocumentSection, ExtractDocumentOptions, ExtractedDocument } from './types.js'

export async function extractDocx(
  buffer: Buffer,
  bytes: number,
  limits: EffectiveReadLimits,
): Promise<ExtractedDocument> {
  const result = await mammoth.extractRawText({ buffer })
  const clipped = clipText(result.value.trim(), limits.maxChars)
  const paragraphs = splitParagraphs(clipped.value).slice(0, limits.maxSections * 100)
  const notes: string[] = []
  if (result.messages.length > 0) notes.push(`解析器报告 ${result.messages.length} 条格式提示。`)
  if (clipped.truncated) notes.push('内容已按字符预算截断。')
  return buildExtracted('docx', [{ title: '正文', paragraphs }], clipped.truncated, notes, { bytes })
}

export function extractWorkbook(
  buffer: Buffer,
  bytes: number,
  format: 'xlsx' | 'xls' | 'csv' | 'tsv',
  options: ExtractDocumentOptions,
  limits: EffectiveReadLimits,
): ExtractedDocument {
  const result = readWorkbookSections(buffer, {
    format,
    maxSections: limits.maxSections,
    maxRowsPerSheet: limits.maxRowsPerSheet,
    maxColumnsPerRow: MAX_CREATE_COLUMNS,
    maxChars: limits.maxChars,
    requestedSheetNames: options.sheetNames,
  })
  const notes = result.truncated ? ['内容已按工作表、行列或字符预算截断。'] : []
  return buildExtracted(format, result.sections, result.truncated, notes, {
    bytes,
    sheetCount: result.sheetCount,
  })
}

export async function extractPresentation(
  buffer: Buffer,
  bytes: number,
  limits: EffectiveReadLimits,
): Promise<ExtractedDocument> {
  const zip = await loadOfficeZip(buffer)
  const entries = boundedZipEntryNames(zip)
  if (entries.truncated) {
    throw new Error(`PPTX 包含 ${entries.total} 个条目，超过安全上限 ${MAX_ZIP_ENTRIES}。`)
  }
  const slideNames = entries.names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/iu.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  const selected = slideNames.slice(0, limits.maxSections)
  let truncated = selected.length < slideNames.length
  let remaining = limits.maxChars
  const sections: DocumentSection[] = []
  for (const name of selected) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const entry = zip.file(name)
    if (!entry) continue
    const xmlResult = await readBoundedZipText(entry)
    if (xmlResult.oversized) {
      throw new Error(`幻灯片 ${slideNumber(name)} 解压后超过安全上限。`)
    }
    const clipped = clipText(extractSlideText(xmlResult.text), remaining)
    remaining -= clipped.value.length
    if (clipped.truncated) truncated = true
    sections.push({ title: `幻灯片 ${slideNumber(name)}`, paragraphs: splitParagraphs(clipped.value) })
  }
  const notes = truncated ? ['内容已按幻灯片数或字符预算截断。'] : []
  if (sections.every((section) => (section.paragraphs ?? []).length === 0)) {
    notes.push('没有找到可提取的幻灯片文字。')
  }
  return buildExtracted('pptx', sections, truncated, notes, { bytes, slideCount: slideNames.length })
}

function extractSlideText(xml: string): string {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/giu)].map((paragraph) => (
    extractDrawingMlTextRuns(paragraph[1]!)
      .join('')
      .trim()
  )).filter(Boolean).join('\n')
}
