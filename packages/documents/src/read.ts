// Owns document format routing, file bounds, and the public extraction entry point.
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_EXTRACTED_CHARS,
  DEFAULT_MAX_ROWS_PER_SHEET,
  DEFAULT_MAX_SECTIONS,
  positiveLimit,
} from './limits.js'
import { extractDocx, extractPresentation, extractWorkbook } from './read-office.js'
import { extractPdf } from './read-pdf.js'
import type { EffectiveReadLimits } from './read-shared.js'
import type { ExtractDocumentOptions, ExtractedDocument, ReadableDocumentFormat } from './types.js'

const FORMAT_BY_EXTENSION: Record<string, ReadableDocumentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.docm': 'docx',
  '.dotx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xlsb': 'xlsx',
  '.xltx': 'xlsx',
  '.xls': 'xls',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.ppsx': 'pptx',
}

export class UnsupportedDocumentFormatError extends Error {
  constructor(extension: string) {
    const suffix = extension || '(无扩展名)'
    const legacy = extension === '.doc' || extension === '.ppt' || extension === '.pps'
      ? ' 请先用 Office 或 LibreOffice 转换为 DOCX 或 PPTX。'
      : ''
    super(`不支持读取 ${suffix} 文件。支持 PDF、DOCX、XLS/XLSX、CSV/TSV 和 PPTX。${legacy}`)
    this.name = 'UnsupportedDocumentFormatError'
  }
}

export async function extractDocument(
  filePath: string,
  options: ExtractDocumentOptions = {},
): Promise<ExtractedDocument> {
  const extension = extname(filePath).toLowerCase()
  const format = FORMAT_BY_EXTENSION[extension]
  if (!format) throw new UnsupportedDocumentFormatError(extension)

  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_DOCUMENT_BYTES, 250 * 1024 * 1024)
  const fileInfo = await stat(filePath)
  if (!fileInfo.isFile()) throw new Error(`不是普通文件：${filePath}`)
  if (fileInfo.size > maxBytes) {
    throw new Error(`文件大小为 ${fileInfo.size} 字节，超过读取上限 ${maxBytes} 字节。`)
  }
  const buffer = await readFile(filePath)
  if (buffer.byteLength > maxBytes) {
    throw new Error(`文件在读取期间增长并超过 ${maxBytes} 字节，已停止处理。`)
  }

  const limits: EffectiveReadLimits = {
    maxChars: positiveLimit(options.maxChars, DEFAULT_MAX_EXTRACTED_CHARS, 1_000_000),
    maxSections: positiveLimit(options.maxSections, DEFAULT_MAX_SECTIONS, 1_000),
    maxRowsPerSheet: positiveLimit(options.maxRowsPerSheet, DEFAULT_MAX_ROWS_PER_SHEET, 10_000),
  }

  switch (format) {
    case 'pdf':
      return extractPdf(buffer, fileInfo.size, options, limits)
    case 'docx':
      return extractDocx(buffer, fileInfo.size, limits)
    case 'xlsx':
    case 'xls':
    case 'csv':
    case 'tsv':
      return extractWorkbook(buffer, fileInfo.size, format, options, limits)
    case 'pptx':
      return extractPresentation(buffer, fileInfo.size, limits)
  }
}
