// Extracts bounded content from DOCX, spreadsheet, and PPTX container formats.
import JSZip from 'jszip'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { MAX_CREATE_COLUMNS, clipText } from './limits.js'
import { buildExtracted, splitParagraphs, type EffectiveReadLimits } from './read-shared.js'
import type { DocumentSection, ExtractDocumentOptions, ExtractedDocument } from './types.js'

const MAX_ZIP_ENTRIES = 4_096
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024

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
  const workbook = XLSX.read(buffer, {
    type: 'buffer', cellDates: true, dense: false, raw: false,
    ...(format === 'tsv' ? { FS: '\t' } : {}),
  })
  const requested = new Set((options.sheetNames ?? []).map((name) => name.toLocaleLowerCase()))
  const selectedNames = workbook.SheetNames
    .filter((name) => requested.size === 0 || requested.has(name.toLocaleLowerCase()))
    .slice(0, limits.maxSections)
  if (requested.size > 0 && selectedNames.length === 0) {
    throw new Error(`未找到请求的工作表。可用工作表：${workbook.SheetNames.join('、')}`)
  }

  const sections: DocumentSection[] = []
  let truncated = selectedNames.length < workbook.SheetNames.length && requested.size === 0
  let remaining = limits.maxChars
  for (const sheetName of selectedNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet || remaining <= 0) break
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1, blankrows: false, raw: false, defval: '',
    })
    if (rawRows.length > limits.maxRowsPerSheet) truncated = true
    const rows: string[][] = []
    for (const rawRow of rawRows.slice(0, limits.maxRowsPerSheet)) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (rawRow.length > MAX_CREATE_COLUMNS) truncated = true
      rows.push(rawRow.slice(0, MAX_CREATE_COLUMNS).map((cell) => {
        const clipped = String(cell ?? '').slice(0, Math.max(0, remaining))
        remaining -= clipped.length
        return clipped
      }))
    }
    sections.push({ title: sheetName, rows })
  }
  if (selectedNames.length > sections.length) truncated = true
  const notes = truncated ? ['内容已按工作表、行列或字符预算截断。'] : []
  return buildExtracted(format, sections, truncated, notes, {
    bytes,
    sheetCount: workbook.SheetNames.length,
  })
}

export async function extractPresentation(
  buffer: Buffer,
  bytes: number,
  limits: EffectiveReadLimits,
): Promise<ExtractedDocument> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
  const entryNames = Object.keys(zip.files)
  if (entryNames.length > MAX_ZIP_ENTRIES) {
    throw new Error(`PPTX 包含 ${entryNames.length} 个条目，超过安全上限 ${MAX_ZIP_ENTRIES}。`)
  }
  const slideNames = entryNames
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
    assertZipEntrySize(entry)
    const xml = await entry.async('string')
    if (Buffer.byteLength(xml, 'utf8') > MAX_XML_ENTRY_BYTES) {
      throw new Error(`幻灯片 ${slideNumber(name)} 解压后超过安全上限。`)
    }
    const clipped = clipText(extractSlideText(xml), remaining)
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

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/iu.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function extractSlideText(xml: string): string {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/giu)].map((paragraph) => (
    [...paragraph[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/giu)]
      .map((match) => decodeXmlEntities(match[1] ?? ''))
      .join('')
      .trim()
  )).filter(Boolean).join('\n')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function assertZipEntrySize(entry: JSZip.JSZipObject): void {
  const internal = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: unknown } })._data
  const declared = internal?.uncompressedSize
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > MAX_XML_ENTRY_BYTES) {
    throw new Error(`压缩包条目解压后为 ${declared} 字节，超过安全上限 ${MAX_XML_ENTRY_BYTES}。`)
  }
}
