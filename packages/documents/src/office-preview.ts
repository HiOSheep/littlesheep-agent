// Bounded Office/OpenDocument previews for UI adapters. This module never
// receives a path; callers retain path authorization and provide a loader.
import mammoth from 'mammoth'
import {
  boundedZipEntryNames,
  decodeXmlEntities,
  extractDrawingMlTextRuns,
  loadOfficeZip,
  readBoundedZipText,
  readWorkbookSections,
  slideNumber,
} from './read-office-shared.js'
import type { DocumentSection, OfficePreview, OfficePreviewInput, OfficePreviewKind } from './types.js'

export const MAX_OFFICE_FILE_BYTES = 24 * 1024 * 1024
export const MAX_PREVIEW_CHARS = 180_000
export const MAX_SECTIONS = 48
export const MAX_PARAGRAPHS_PER_SECTION = 1_200
export const MAX_ROWS_PER_SHEET = 220
export const MAX_COLUMNS_PER_ROW = 40
export const MAX_XML_ENTRY_CHARS = 1_500_000
export const MAX_XML_ENTRY_BYTES = MAX_XML_ENTRY_CHARS * 4

export const OOXML_DOCUMENT_EXTS = new Set(['.docx', '.docm', '.dotx', '.dotm'])
export const OOXML_PRESENTATION_EXTS = new Set(['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm'])
export const SPREADSHEET_EXTS = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.csv', '.tsv'])
export const OPEN_DOCUMENT_EXTS = new Set(['.odt', '.odp', '.ods'])

export async function previewOfficeDocument(input: OfficePreviewInput): Promise<OfficePreview> {
  const extension = input.extension.toLowerCase()
  const officeKind = officeKindForExtension(extension)
  if (input.byteLength > MAX_OFFICE_FILE_BYTES) return oversizedPreview(officeKind)
  const buffer = await input.load()
  if (buffer.byteLength > MAX_OFFICE_FILE_BYTES) return oversizedPreview(officeKind)

  try {
    if (SPREADSHEET_EXTS.has(extension)) return previewSpreadsheet(buffer, extension)
    if (OOXML_DOCUMENT_EXTS.has(extension)) return await previewDocx(buffer, officeKind)
    if (OOXML_PRESENTATION_EXTS.has(extension)) return await previewPresentation(buffer, officeKind)
    if (OPEN_DOCUMENT_EXTS.has(extension)) return await previewOpenDocument(buffer, officeKind)
    return previewLegacyBinary(buffer, officeKind)
  } catch (error) {
    return {
      officeKind,
      sections: [],
      truncated: false,
      note: `内部预览失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function oversizedPreview(officeKind: OfficePreviewKind): OfficePreview {
  return {
    officeKind,
    sections: [],
    truncated: true,
    note: `文件超过 ${Math.round(MAX_OFFICE_FILE_BYTES / 1024 / 1024)} MB，已停止读取二进制内容。`,
  }
}

function officeKindForExtension(extension: string): OfficePreviewKind {
  if (SPREADSHEET_EXTS.has(extension) || extension === '.ods') return 'spreadsheet'
  if (OOXML_PRESENTATION_EXTS.has(extension)
    || extension === '.odp'
    || extension === '.ppt'
    || extension === '.pps') return 'presentation'
  return 'document'
}

function previewSpreadsheet(buffer: Buffer, extension: string): OfficePreview {
  const format = extension === '.tsv'
    ? 'tsv'
    : extension === '.csv'
      ? 'csv'
      : extension === '.xls' || extension === '.xlt'
        ? 'xls'
        : 'xlsx'
  const result = readWorkbookSections(buffer, {
    format,
    maxSections: MAX_SECTIONS,
    maxRowsPerSheet: MAX_ROWS_PER_SHEET,
    maxColumnsPerRow: MAX_COLUMNS_PER_ROW,
    maxChars: MAX_PREVIEW_CHARS,
    trimCells: true,
    includeEmptySectionsAfterBudget: true,
  })
  return {
    officeKind: 'spreadsheet',
    sections: result.sections,
    truncated: result.truncated,
  }
}

async function previewDocx(buffer: Buffer, officeKind: OfficePreviewKind): Promise<OfficePreview> {
  const result = await mammoth.extractRawText({ buffer })
  const paragraphs = splitPreviewParagraphs(result.value)
  return withCharacterBudget({
    officeKind,
    sections: [{ title: '正文', paragraphs: paragraphs.values }],
    truncated: paragraphs.truncated,
    note: result.messages.length > 0 ? `文档解析完成，存在 ${result.messages.length} 条格式提示。` : undefined,
  })
}

async function previewPresentation(
  buffer: Buffer,
  officeKind: OfficePreviewKind,
): Promise<OfficePreview> {
  const zip = await loadOfficeZip(buffer)
  const entries = boundedZipEntryNames(zip)
  const slideNames = entries.names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/iu.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  let truncated = entries.truncated || slideNames.length > MAX_SECTIONS
  const sections: DocumentSection[] = []
  for (const name of slideNames.slice(0, MAX_SECTIONS)) {
    const entry = zip.file(name)
    if (!entry) continue
    const xmlResult = await readBoundedZipText(entry, MAX_XML_ENTRY_BYTES)
    if (xmlResult.oversized) {
      truncated = true
      sections.push({ title: `幻灯片 ${slideNumber(name)}`, paragraphs: ['此页内容超过预览上限，已跳过。'] })
      continue
    }
    const xml = xmlResult.text.slice(0, MAX_XML_ENTRY_CHARS)
    const paragraphs = splitPreviewParagraphs(extractXmlText(xml))
    sections.push({ title: `幻灯片 ${slideNumber(name)}`, paragraphs: paragraphs.values })
    if (paragraphs.truncated || xmlResult.text.length >= MAX_XML_ENTRY_CHARS) truncated = true
  }
  if (sections.length === 0) {
    return previewLegacyBinary(buffer, officeKind, '演示文稿中没有找到可读取的幻灯片文本。')
  }
  return withCharacterBudget({ officeKind, sections, truncated })
}

async function previewOpenDocument(
  buffer: Buffer,
  officeKind: OfficePreviewKind,
): Promise<OfficePreview> {
  const zip = await loadOfficeZip(buffer)
  const entries = boundedZipEntryNames(zip)
  if (entries.truncated) {
    return {
      officeKind,
      sections: [],
      truncated: true,
      note: 'OpenDocument 条目过多，已停止预览。',
    }
  }
  const entry = zip.file('content.xml')
  if (!entry) return previewLegacyBinary(buffer, officeKind, 'OpenDocument 中没有找到内容文件。')
  const xmlResult = await readBoundedZipText(entry, MAX_XML_ENTRY_BYTES)
  if (xmlResult.oversized) {
    return {
      officeKind,
      sections: [],
      truncated: true,
      note: 'OpenDocument 内容超过预览上限，已跳过。',
    }
  }
  const xml = xmlResult.text.slice(0, MAX_XML_ENTRY_CHARS)
  const paragraphs = splitPreviewParagraphs(extractXmlText(xml))
  return withCharacterBudget({
    officeKind,
    sections: [{ title: '正文', paragraphs: paragraphs.values }],
    truncated: paragraphs.truncated || xmlResult.text.length >= MAX_XML_ENTRY_CHARS,
  })
}

function previewLegacyBinary(
  buffer: Buffer,
  officeKind: OfficePreviewKind,
  note = '该格式已在 LS 内打开，但当前只能显示其中可安全提取的文字。',
): OfficePreview {
  const strings = extractPrintableStrings(buffer)
  return withCharacterBudget({
    officeKind,
    sections: [{ title: '可读取文本', paragraphs: strings.values }],
    truncated: strings.truncated,
    note,
  })
}

function splitPreviewParagraphs(value: string): { values: string[]; truncated: boolean } {
  const values = value
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}|\n/gu)
    .map((line) => line.replace(/\s+$/gu, '').trim())
    .filter(Boolean)
  return {
    values: values.slice(0, MAX_PARAGRAPHS_PER_SECTION),
    truncated: values.length >= MAX_PARAGRAPHS_PER_SECTION,
  }
}

function extractXmlText(xml: string): string {
  const text = extractDrawingMlTextRuns(xml)
  if (text.length > 0) return text.join(' ')
  return decodeXmlEntities(xml.replace(/<[^>]+>/gu, ' '))
}

function extractPrintableStrings(buffer: Buffer): { values: string[]; truncated: boolean } {
  const maxRunChars = MAX_PREVIEW_CHARS + 1
  const result: string[] = []
  let truncated = false
  const addRun = (value: string, runTruncated: boolean) => {
    if (runTruncated) truncated = true
    const normalized = value.replace(/\s+/gu, ' ').trim()
    if (normalized.length < 4 || result.includes(normalized)) return
    if (result.length >= MAX_PARAGRAPHS_PER_SECTION) {
      truncated = true
      return
    }
    result.push(normalized)
  }
  let ascii = ''
  let asciiTruncated = false
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      if (ascii.length < maxRunChars) ascii += String.fromCharCode(byte)
      else asciiTruncated = true
    }
    else {
      addRun(ascii, asciiTruncated)
      if (truncated || result.length >= MAX_PARAGRAPHS_PER_SECTION) {
        return { values: result, truncated: true }
      }
      ascii = ''
      asciiTruncated = false
    }
  }
  addRun(ascii, asciiTruncated)
  if (truncated || result.length >= MAX_PARAGRAPHS_PER_SECTION) {
    return { values: result, truncated: true }
  }

  let utf16 = ''
  let utf16Truncated = false
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = buffer[index]! | (buffer[index + 1]! << 8)
    if ((code >= 32 && code <= 126) || code >= 0x3000) {
      if (utf16.length < maxRunChars) utf16 += String.fromCharCode(code)
      else utf16Truncated = true
    }
    else {
      addRun(utf16, utf16Truncated)
      if (truncated || result.length >= MAX_PARAGRAPHS_PER_SECTION) {
        return { values: result, truncated: true }
      }
      utf16 = ''
      utf16Truncated = false
    }
  }
  addRun(utf16, utf16Truncated)
  if (result.length >= MAX_PARAGRAPHS_PER_SECTION) truncated = true
  return { values: result, truncated }
}

function withCharacterBudget(preview: OfficePreview): OfficePreview {
  let remaining = MAX_PREVIEW_CHARS
  let truncated = preview.truncated
  const sections = preview.sections.map((section) => {
    if (section.rows) {
      const rows: string[][] = []
      for (const row of section.rows) {
        if (remaining <= 0) {
          truncated = true
          break
        }
        rows.push(row.map((cell) => {
          const value = cell.slice(0, Math.max(0, remaining))
          remaining -= value.length
          if (value.length < cell.length) truncated = true
          return value
        }))
      }
      if (rows.length < section.rows.length) truncated = true
      return { ...section, rows }
    }
    const paragraphs: string[] = []
    for (const paragraph of section.paragraphs ?? []) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      const value = paragraph.slice(0, remaining)
      remaining -= value.length
      paragraphs.push(value)
      if (value.length < paragraph.length) {
        truncated = true
        break
      }
    }
    if (paragraphs.length < (section.paragraphs?.length ?? 0)) truncated = true
    return { ...section, paragraphs }
  })
  return { ...preview, sections, truncated }
}
