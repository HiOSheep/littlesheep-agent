import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import type { DocumentSection } from './types.js'

export const MAX_ZIP_ENTRIES = 4_096
export const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024

export interface WorkbookSectionOptions {
  format: 'xlsx' | 'xls' | 'csv' | 'tsv'
  maxSections: number
  maxRowsPerSheet: number
  maxColumnsPerRow: number
  maxChars: number
  requestedSheetNames?: string[]
  trimCells?: boolean
  includeEmptySectionsAfterBudget?: boolean
}

export interface WorkbookSectionResult {
  sections: DocumentSection[]
  truncated: boolean
  sheetCount: number
}

export function readWorkbookSections(
  buffer: Buffer,
  options: WorkbookSectionOptions,
): WorkbookSectionResult {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    dense: true,
    raw: false,
    ...(options.format === 'tsv' ? { FS: '\t' } : {}),
  })
  const requested = new Set((options.requestedSheetNames ?? []).map((name) => name.toLocaleLowerCase()))
  const selectedNames = workbook.SheetNames
    .filter((name) => requested.size === 0 || requested.has(name.toLocaleLowerCase()))
    .slice(0, options.maxSections)
  if (requested.size > 0 && selectedNames.length === 0) {
    throw new Error(`未找到请求的工作表。可用工作表：${workbook.SheetNames.join('、')}`)
  }

  const sections: DocumentSection[] = []
  let truncated = selectedNames.length < workbook.SheetNames.length && requested.size === 0
  let remaining = options.maxChars
  for (const sheetName of selectedNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    if (remaining <= 0) {
      truncated = true
      if (options.includeEmptySectionsAfterBudget) sections.push({ title: sheetName, rows: [] })
      continue
    }

    const boundedRange = boundedWorksheetRange(sheet, options.maxRowsPerSheet, options.maxColumnsPerRow)
    if (boundedRange.truncated) truncated = true
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
      ...(options.trimCells ? {} : { defval: '' }),
      ...(boundedRange.range ? { range: boundedRange.range } : {}),
    })
    if (rawRows.length > options.maxRowsPerSheet) truncated = true

    const rows: string[][] = []
    for (const rawRow of rawRows.slice(0, options.maxRowsPerSheet)) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (rawRow.length > options.maxColumnsPerRow) truncated = true
      const row: string[] = []
      for (const cell of rawRow.slice(0, options.maxColumnsPerRow)) {
        const value = normalizeCell(cell, options.trimCells ?? false)
        const clipped = value.slice(0, Math.max(0, remaining))
        remaining -= clipped.length
        if (clipped.length < value.length) truncated = true
        row.push(clipped)
      }
      rows.push(row)
    }
    sections.push({ title: sheetName, rows })
  }
  if (selectedNames.length > sections.length) truncated = true
  return { sections, truncated, sheetCount: workbook.SheetNames.length }
}

function boundedWorksheetRange(
  sheet: XLSX.WorkSheet,
  maxRows: number,
  maxColumns: number,
): { range?: string; truncated: boolean } {
  const reference = sheet['!ref']
  if (!reference) return { truncated: false }
  let decoded: XLSX.Range
  try {
    decoded = XLSX.utils.decode_range(reference)
  } catch {
    throw new Error(`工作表范围无效：${reference}`)
  }
  const rowCount = decoded.e.r - decoded.s.r + 1
  const columnCount = decoded.e.c - decoded.s.c + 1
  const bounded = {
    s: decoded.s,
    e: {
      r: Math.min(decoded.e.r, decoded.s.r + maxRows - 1),
      c: Math.min(decoded.e.c, decoded.s.c + maxColumns - 1),
    },
  }
  return {
    range: XLSX.utils.encode_range(bounded),
    truncated: rowCount > maxRows || columnCount > maxColumns,
  }
}

function normalizeCell(value: unknown, trim: boolean): string {
  const text = String(value ?? '')
  return trim ? text.trim() : text
}

export async function loadOfficeZip(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
}

export function boundedZipEntryNames(
  zip: JSZip,
  maxEntries = MAX_ZIP_ENTRIES,
): { names: string[]; total: number; truncated: boolean } {
  const allNames = Object.keys(zip.files)
  return {
    names: allNames.slice(0, maxEntries),
    total: allNames.length,
    truncated: allNames.length > maxEntries,
  }
}

export async function readBoundedZipText(
  entry: JSZip.JSZipObject,
  maxBytes = MAX_XML_ENTRY_BYTES,
): Promise<{
  text: string
  declaredBytes: number | null
  actualBytes: number | null
  oversized: boolean
}> {
  const declaredBytes = zipEntryUncompressedBytes(entry)
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    return { text: '', declaredBytes, actualBytes: null, oversized: true }
  }
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer') as Readable
    const chunks: Buffer[] = []
    let actualBytes = 0
    let settled = false
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      actualBytes += bytes.byteLength
      if (actualBytes > maxBytes) {
        settled = true
        stream.pause()
        stream.destroy()
        resolve({ text: '', declaredBytes, actualBytes, oversized: true })
        return
      }
      chunks.push(bytes)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve({
        text: Buffer.concat(chunks, actualBytes).toString('utf8'),
        declaredBytes,
        actualBytes,
        oversized: false,
      })
    })
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

export function zipEntryUncompressedBytes(entry: JSZip.JSZipObject): number | null {
  const data = (entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown }
  })._data
  const size = data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null
}

export function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/iu.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

export function extractDrawingMlTextRuns(xml: string): string[] {
  return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/giu)]
    .map((match) => decodeXmlEntities(match[1] ?? ''))
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}
