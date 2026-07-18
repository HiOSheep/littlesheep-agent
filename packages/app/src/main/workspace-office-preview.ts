// Bounded, read-only previews for common document formats.
// The renderer receives structured text only; binary Office payloads never cross the API.

import { readFile, stat } from 'node:fs/promises'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'

export type WorkspaceOfficeKind = 'document' | 'spreadsheet' | 'presentation'

export interface WorkspaceOfficeSection {
  title: string
  paragraphs?: string[]
  rows?: string[][]
}

export interface WorkspaceOfficePreview {
  kind: 'office'
  officeKind: WorkspaceOfficeKind
  sections: WorkspaceOfficeSection[]
  truncated: boolean
  note?: string
}

const MAX_OFFICE_FILE_BYTES = 24 * 1024 * 1024
const MAX_PREVIEW_CHARS = 180_000
const MAX_SECTIONS = 48
const MAX_PARAGRAPHS_PER_SECTION = 1_200
const MAX_ROWS_PER_SHEET = 220
const MAX_COLUMNS_PER_ROW = 40
const MAX_XML_ENTRY_CHARS = 1_500_000
const MAX_XML_ENTRY_BYTES = MAX_XML_ENTRY_CHARS * 4
const MAX_ZIP_ENTRIES = 4_096

const OOXML_DOCUMENT_EXTS = new Set(['.docx', '.docm', '.dotx', '.dotm'])
const OOXML_PRESENTATION_EXTS = new Set(['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm'])
const SPREADSHEET_EXTS = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx'])

export async function previewWorkspaceOfficeFile(filePath: string, extension: string): Promise<WorkspaceOfficePreview> {
  const ext = extension.toLowerCase()
  const officeKind = officeKindForExtension(ext)
  const fileInfo = await stat(filePath)
  if (fileInfo.size > MAX_OFFICE_FILE_BYTES) return oversizedPreview(officeKind)
  const info = await readFile(filePath)
  // The file can grow between stat and readFile. Keep the second check so a
  // concurrent write cannot bypass the memory bound.
  if (info.byteLength > MAX_OFFICE_FILE_BYTES) return oversizedPreview(officeKind)

  try {
    if (SPREADSHEET_EXTS.has(ext)) return previewSpreadsheet(info, officeKind)
    if (OOXML_DOCUMENT_EXTS.has(ext)) return previewDocx(info, officeKind)
    if (OOXML_PRESENTATION_EXTS.has(ext)) return previewPresentation(info, officeKind)
    if (ext === '.odt' || ext === '.odp' || ext === '.ods') return previewOpenDocument(info, officeKind)
    return previewLegacyBinary(info, officeKind)
  } catch (error) {
    return {
      kind: 'office',
      officeKind,
      sections: [],
      truncated: false,
      note: `内部预览失败：${(error as Error).message}`,
    }
  }
}

function oversizedPreview(officeKind: WorkspaceOfficeKind): WorkspaceOfficePreview {
  return {
    kind: 'office',
    officeKind,
    sections: [],
    truncated: true,
    note: `文件超过 ${Math.round(MAX_OFFICE_FILE_BYTES / 1024 / 1024)} MB，已停止读取二进制内容。`,
  }
}

function officeKindForExtension(extension: string): WorkspaceOfficeKind {
  if (SPREADSHEET_EXTS.has(extension) || extension === '.ods') return 'spreadsheet'
  if (OOXML_PRESENTATION_EXTS.has(extension) || extension === '.odp' || extension === '.ppt' || extension === '.pps') return 'presentation'
  return 'document'
}

async function previewSpreadsheet(
  buffer: Buffer,
  officeKind: WorkspaceOfficeKind,
): Promise<WorkspaceOfficePreview> {
  const workbook = XLSX.read(buffer, { cellDates: true, dense: true })
  const sections: WorkspaceOfficeSection[] = []
  let truncated = false
  for (const sheetName of workbook.SheetNames.slice(0, MAX_SECTIONS)) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    })
    if (rawRows.length > MAX_ROWS_PER_SHEET) truncated = true
    const rows = rawRows.slice(0, MAX_ROWS_PER_SHEET).map((row) => (
      row.slice(0, MAX_COLUMNS_PER_ROW).map((cell) => String(cell ?? '').trim())
    ))
    if (rawRows.some((row) => row.length > MAX_COLUMNS_PER_ROW)) truncated = true
    sections.push({ title: sheetName, rows })
  }
  if (workbook.SheetNames.length > MAX_SECTIONS) truncated = true
  return withCharacterBudget({
    kind: 'office',
    officeKind,
    sections,
    truncated,
  })
}

async function previewDocx(buffer: Buffer, officeKind: WorkspaceOfficeKind): Promise<WorkspaceOfficePreview> {
  const result = await mammoth.extractRawText({ buffer })
  const paragraphs = splitParagraphs(result.value)
  return withCharacterBudget({
    kind: 'office',
    officeKind,
    sections: [{ title: '正文', paragraphs }],
    truncated: paragraphs.length >= MAX_PARAGRAPHS_PER_SECTION,
    note: result.messages.length > 0 ? `文档解析完成，存在 ${result.messages.length} 条格式提示。` : undefined,
  })
}

async function previewPresentation(
  buffer: Buffer,
  officeKind: WorkspaceOfficeKind,
): Promise<WorkspaceOfficePreview> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
  const allNames = Object.keys(zip.files)
  const candidateNames = allNames.slice(0, MAX_ZIP_ENTRIES)
  const slideNames = candidateNames
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/iu.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  let truncated = allNames.length > MAX_ZIP_ENTRIES || slideNames.length > MAX_SECTIONS
  const sections: WorkspaceOfficeSection[] = []
  for (const name of slideNames.slice(0, MAX_SECTIONS)) {
    const entry = zip.file(name)
    if (!entry) continue
    const xmlResult = await readBoundedZipText(entry)
    if (xmlResult.skipped) {
      truncated = true
      sections.push({ title: `幻灯片 ${slideNumber(name)}`, paragraphs: ['此页内容超过预览上限，已跳过。'] })
      continue
    }
    const xml = xmlResult.text.slice(0, MAX_XML_ENTRY_CHARS)
    const paragraphs = splitParagraphs(extractXmlText(xml))
    sections.push({ title: `幻灯片 ${slideNumber(name)}`, paragraphs })
    if (xmlResult.truncated || xml.length >= MAX_XML_ENTRY_CHARS) truncated = true
  }
  if (sections.length === 0) {
    return previewLegacyBinary(buffer, officeKind, '演示文稿中没有找到可读取的幻灯片文本。')
  }
  return withCharacterBudget({
    kind: 'office',
    officeKind,
    sections,
    truncated,
  })
}

async function previewOpenDocument(
  buffer: Buffer,
  officeKind: WorkspaceOfficeKind,
): Promise<WorkspaceOfficePreview> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) {
    return {
      kind: 'office',
      officeKind,
      sections: [],
      truncated: true,
      note: 'OpenDocument 条目过多，已停止预览。',
    }
  }
  const entry = zip.file('content.xml')
  if (!entry) return previewLegacyBinary(buffer, officeKind, 'OpenDocument 中没有找到内容文件。')
  const xmlResult = await readBoundedZipText(entry)
  if (xmlResult.skipped) {
    return {
      kind: 'office',
      officeKind,
      sections: [],
      truncated: true,
      note: 'OpenDocument 内容超过预览上限，已跳过。',
    }
  }
  const xml = xmlResult.text.slice(0, MAX_XML_ENTRY_CHARS)
  return withCharacterBudget({
    kind: 'office',
    officeKind,
    sections: [{ title: '正文', paragraphs: splitParagraphs(extractXmlText(xml)) }],
    truncated: xmlResult.truncated || xml.length >= MAX_XML_ENTRY_CHARS,
  })
}

async function readBoundedZipText(entry: JSZip.JSZipObject): Promise<{
  text: string
  truncated: boolean
  skipped: boolean
}> {
  const declaredBytes = zipEntryUncompressedBytes(entry)
  if (declaredBytes !== null && declaredBytes > MAX_XML_ENTRY_BYTES) {
    return { text: '', truncated: true, skipped: true }
  }
  const text = await entry.async('string')
  return {
    text,
    truncated: text.length >= MAX_XML_ENTRY_CHARS || (declaredBytes !== null && declaredBytes > MAX_XML_ENTRY_BYTES),
    skipped: false,
  }
}

function zipEntryUncompressedBytes(entry: JSZip.JSZipObject): number | null {
  const data = (entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown }
  })._data
  const size = data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null
}

function previewLegacyBinary(
  buffer: Buffer,
  officeKind: WorkspaceOfficeKind,
  note = '该格式已在 LS 内打开，但当前只能显示其中可安全提取的文字。',
): WorkspaceOfficePreview {
  const strings = extractPrintableStrings(buffer)
  return withCharacterBudget({
    kind: 'office',
    officeKind,
    sections: [{ title: '可读取文本', paragraphs: strings }],
    truncated: strings.length >= MAX_PARAGRAPHS_PER_SECTION,
    note,
  })
}

function splitParagraphs(value: string): string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}|\n/)
    .map((line) => line.replace(/\s+$/g, '').trim())
    .filter(Boolean)
    .slice(0, MAX_PARAGRAPHS_PER_SECTION)
}

function extractXmlText(xml: string): string {
  const text = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/giu)]
    .map((match) => decodeXmlEntities(match[1] ?? ''))
  if (text.length > 0) return text.join(' ')
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, ' '))
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function extractPrintableStrings(buffer: Buffer): string[] {
  const result: string[] = []
  const addRun = (value: string) => {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length >= 4 && !result.includes(normalized)) result.push(normalized)
  }
  let ascii = ''
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) ascii += String.fromCharCode(byte)
    else {
      addRun(ascii)
      ascii = ''
    }
    if (result.length >= MAX_PARAGRAPHS_PER_SECTION) return result
  }
  addRun(ascii)

  let utf16 = ''
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = buffer[index]! | (buffer[index + 1]! << 8)
    if ((code >= 32 && code <= 126) || code >= 0x3000) utf16 += String.fromCharCode(code)
    else {
      addRun(utf16)
      utf16 = ''
    }
    if (result.length >= MAX_PARAGRAPHS_PER_SECTION) return result
  }
  addRun(utf16)
  return result.slice(0, MAX_PARAGRAPHS_PER_SECTION)
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/iu.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function withCharacterBudget(preview: WorkspaceOfficePreview): WorkspaceOfficePreview {
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
        const next = row.map((cell) => {
          const value = cell.slice(0, Math.max(0, remaining))
          remaining -= value.length
          return value
        })
        rows.push(next)
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
      const next = paragraph.slice(0, remaining)
      remaining -= next.length
      paragraphs.push(next)
      if (next.length < paragraph.length) {
        truncated = true
        break
      }
    }
    if (paragraphs.length < (section.paragraphs?.length ?? 0)) truncated = true
    return { ...section, paragraphs }
  })
  return { ...preview, sections, truncated }
}
