// Generates typed XLSX workbooks and UTF-8 CSV output with formula preservation.
import * as XLSX from 'xlsx'
import { isFormulaCell, normalizeFormula } from './write-spreadsheet-shared.js'
import type { CreateDocumentInput, SpreadsheetFormulaCell, SpreadsheetSheet } from './types.js'

export function buildXlsx(input: CreateDocumentInput): Buffer {
  const workbook = XLSX.utils.book_new()
  for (const source of input.sheets ?? []) {
    XLSX.utils.book_append_sheet(workbook, buildWorksheet(source), source.name)
  }
  workbook.Props = { Title: input.title, Subject: input.subtitle, Author: 'LittleSheep' }
  return XLSX.write(workbook, {
    type: 'buffer', bookType: 'xlsx', cellStyles: true, compression: true,
  }) as Buffer
}

export function buildCsv(input: CreateDocumentInput): Buffer {
  const source = input.sheets![0]!
  const sheet = buildWorksheet(source)
  const text = XLSX.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n', blankrows: false, strip: false })
  return Buffer.from(`\uFEFF${text}`, 'utf8')
}

function buildWorksheet(source: SpreadsheetSheet): XLSX.WorkSheet {
  const values = source.rows.map((row) => row.map((cell) => isFormulaCell(cell) ? cell.value : cell))
  const sheet = XLSX.utils.aoa_to_sheet(values, { cellDates: true })
  source.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (!isFormulaCell(cell)) return
    const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
    const target = sheet[address] ?? { t: cellType(cell.value), v: cell.value }
    target.f = normalizeFormula(cell.formula)
    if (cell.numberFormat) target.z = cell.numberFormat
    sheet[address] = target
  }))
  const columnCount = Math.max(0, ...source.rows.map((row) => row.length))
  sheet['!cols'] = Array.from({ length: columnCount }, (_value, columnIndex) => {
    const longest = source.rows.reduce((max, row) => {
      const cell = row[columnIndex]
      const text = isFormulaCell(cell) ? String(cell.value) : String(cell ?? '')
      return Math.max(max, text.length)
    }, 0)
    return { wch: Math.min(40, Math.max(10, longest + 2)) }
  })
  return sheet
}

function cellType(value: SpreadsheetFormulaCell['value']): XLSX.ExcelDataType {
  if (typeof value === 'number') return 'n'
  if (typeof value === 'boolean') return 'b'
  return 's'
}
