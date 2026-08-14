// Reopens generated artifacts and verifies their format-specific structural invariants.
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { extractDocument } from './read.js'
import { EXTENSION_BY_FORMAT, formatFromExtension } from './write-format.js'
import type { CreateDocumentInput, CreatableDocumentFormat } from './types.js'

export async function verifyDocument(
  filePath: string,
  format: CreatableDocumentFormat = formatFromExtension(filePath),
): Promise<string> {
  const expectedExtension = EXTENSION_BY_FORMAT[format]
  if (extname(filePath).toLowerCase() !== expectedExtension) {
    throw new Error(`文件扩展名必须为 ${expectedExtension}。`)
  }
  const fileInfo = await stat(filePath)
  if (!fileInfo.isFile() || fileInfo.size <= 0) throw new Error('生成产物为空或不是普通文件。')

  switch (format) {
    case 'pdf': {
      const extracted = await extractDocument(filePath, { maxChars: 20_000 })
      if (!extracted.metadata.pageCount || extracted.metadata.pageCount < 1) {
        throw new Error('PDF 重新打开后没有有效页面。')
      }
      return `PDF 已重新打开，共 ${extracted.metadata.pageCount} 页。`
    }
    case 'docx': {
      await verifyDocxBuffer(await readFile(filePath))
      const extracted = await extractDocument(filePath, { maxChars: 20_000 })
      return `DOCX 已重新打开，提取到 ${extracted.text.length} 个字符。`
    }
    case 'xlsx': {
      const workbook = XLSX.read(await readFile(filePath), {
        type: 'buffer', cellFormula: true, cellDates: true,
      })
      if (workbook.SheetNames.length === 0) throw new Error('XLSX 重新打开后没有工作表。')
      scanWorkbookFormulaErrors(workbook)
      return `XLSX 已重新打开，共 ${workbook.SheetNames.length} 个工作表。`
    }
    case 'csv': {
      const buffer = await readFile(filePath)
      if (buffer.byteLength === 0) throw new Error('CSV 重新打开后为空。')
      const workbook = XLSX.read(buffer, { type: 'buffer', FS: ',' })
      if (workbook.SheetNames.length !== 1) throw new Error('CSV 重新打开失败。')
      return `CSV 已重新打开，共 ${countSheetRows(workbook.Sheets[workbook.SheetNames[0]!]!)} 行。`
    }
  }
}

export async function verifyPayload(
  payload: Buffer,
  format: CreatableDocumentFormat,
  input: CreateDocumentInput,
): Promise<void> {
  if (payload.byteLength === 0) throw new Error('生成器返回了空产物。')
  if (format === 'pdf' && payload.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDF 生成结果缺少有效文件头。')
  }
  if (format === 'docx') await verifyDocxBuffer(payload)
  if (format === 'xlsx') {
    const workbook = XLSX.read(payload, { type: 'buffer', cellFormula: true })
    if (workbook.SheetNames.length !== input.sheets?.length) throw new Error('XLSX 工作表数量校验失败。')
    scanWorkbookFormulaErrors(workbook)
  }
  if (format === 'csv' && payload.toString('utf8').trim().length === 0) {
    throw new Error('CSV 生成结果为空。')
  }
}

async function verifyDocxBuffer(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false })
  for (const name of ['[Content_Types].xml', 'word/document.xml', '_rels/.rels']) {
    if (!zip.file(name)) throw new Error(`DOCX 缺少必要部件：${name}`)
  }
  const documentXml = await zip.file('word/document.xml')!.async('string')
  if (!/<w:document\b/u.test(documentXml)) throw new Error('DOCX 主文档 XML 无效。')
}

function scanWorkbookFormulaErrors(workbook: XLSX.WorkBook): void {
  const formulaError = /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/iu
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue
      const value = (cell as XLSX.CellObject).v
      if (typeof value === 'string' && formulaError.test(value)) {
        throw new Error(`工作表 ${sheetName} 的 ${address} 包含公式错误 ${value}。`)
      }
    }
  }
}

function countSheetRows(sheet: XLSX.WorkSheet): number {
  const ref = sheet['!ref']
  return ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0
}
