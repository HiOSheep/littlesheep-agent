// Validates document creation requests before any output path is mutated.
import { extname } from 'node:path'
import {
  MAX_CELL_CHARS,
  MAX_CREATE_BLOCKS,
  MAX_CREATE_COLUMNS,
  MAX_CREATE_ROWS,
  MAX_CREATE_SHEETS,
} from './limits.js'
import { isFormulaCell } from './write-spreadsheet-shared.js'
import { EXTENSION_BY_FORMAT } from './write-format.js'
import type { CreateDocumentInput, DocumentBlock, SpreadsheetCell, SpreadsheetSheet } from './types.js'

export function validateCreateInput(input: CreateDocumentInput): void {
  const extension = extname(input.filePath).toLowerCase()
  const expectedExtension = EXTENSION_BY_FORMAT[input.format]
  if (extension !== expectedExtension) {
    throw new Error(`format=${input.format} 的输出路径必须以 ${expectedExtension} 结尾。`)
  }
  if ((input.title ?? '').length > MAX_CELL_CHARS) throw new Error('标题过长。')
  if ((input.subtitle ?? '').length > MAX_CELL_CHARS) throw new Error('副标题过长。')
  if ((input.blocks?.length ?? 0) > MAX_CREATE_BLOCKS) {
    throw new Error(`内容块不能超过 ${MAX_CREATE_BLOCKS} 个。`)
  }
  for (const block of input.blocks ?? []) validateBlock(block)
  validateSheets(input.sheets ?? [])
  if (input.format === 'xlsx' || input.format === 'csv') {
    if (!input.sheets || input.sheets.length === 0) {
      throw new Error(`${input.format.toUpperCase()} 至少需要一个工作表。`)
    }
  } else if (!input.title && !input.subtitle && (!input.blocks || input.blocks.length === 0)) {
    throw new Error(`${input.format.toUpperCase()} 至少需要标题或一个内容块。`)
  }
  if (input.format === 'csv' && input.sheets?.length !== 1) {
    throw new Error('CSV 必须且只能包含一个工作表。')
  }
}

function validateBlock(block: DocumentBlock): void {
  if (block.type === 'page_break') return
  if (block.type === 'table') {
    if (block.rows.length > MAX_CREATE_ROWS) throw new Error(`表格不能超过 ${MAX_CREATE_ROWS} 行。`)
    for (const row of block.rows) {
      if (row.length > MAX_CREATE_COLUMNS) throw new Error(`表格不能超过 ${MAX_CREATE_COLUMNS} 列。`)
      row.forEach(validateCellText)
    }
    if ((block.headerRows ?? 0) > block.rows.length) throw new Error('表头行数不能超过表格总行数。')
    return
  }
  if (block.type === 'bullet_list' || block.type === 'numbered_list') {
    if (block.items.length > MAX_CREATE_ROWS) throw new Error(`列表不能超过 ${MAX_CREATE_ROWS} 项。`)
    block.items.forEach(validateCellText)
    return
  }
  validateCellText(block.text)
}

function validateSheets(sheets: SpreadsheetSheet[]): void {
  if (sheets.length > MAX_CREATE_SHEETS) throw new Error(`工作表不能超过 ${MAX_CREATE_SHEETS} 个。`)
  const names = new Set<string>()
  for (const sheet of sheets) {
    validateSheetName(sheet.name)
    const normalized = sheet.name.toLocaleLowerCase()
    if (names.has(normalized)) throw new Error(`工作表名称重复：${sheet.name}`)
    names.add(normalized)
    if (sheet.rows.length > MAX_CREATE_ROWS) throw new Error(`工作表 ${sheet.name} 不能超过 ${MAX_CREATE_ROWS} 行。`)
    for (const row of sheet.rows) {
      if (row.length > MAX_CREATE_COLUMNS) throw new Error(`工作表 ${sheet.name} 不能超过 ${MAX_CREATE_COLUMNS} 列。`)
      row.forEach(validateSpreadsheetCell)
    }
  }
}

function validateSpreadsheetCell(cell: SpreadsheetCell): void {
  if (typeof cell === 'string') validateCellText(cell)
  if (!isFormulaCell(cell)) return
  if (!cell.formula.trim()) throw new Error('公式不能为空。')
  if (cell.formula.length > MAX_CELL_CHARS) throw new Error('公式过长。')
  if (cell.value === undefined || cell.value === null) {
    throw new Error('公式单元格必须提供已核对的缓存结果 value；当前生成器不会计算 Excel 公式。')
  }
  if (typeof cell.value === 'string') validateCellText(cell.value)
  if ((cell.numberFormat ?? '').length > 128) throw new Error('数字格式过长。')
}

function validateCellText(value: string): void {
  if (value.length > MAX_CELL_CHARS) throw new Error(`单个文本值不能超过 ${MAX_CELL_CHARS} 个字符。`)
}

function validateSheetName(name: string): void {
  if (!name.trim() || name.length > 31 || /[\\/*?:\[\]]/u.test(name)) {
    throw new Error(`无效的工作表名称：${name || '(空)'}`)
  }
}
