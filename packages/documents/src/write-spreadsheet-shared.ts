// Shared spreadsheet cell predicates and formula normalization.
import type { SpreadsheetCell, SpreadsheetFormulaCell } from './types.js'

export function isFormulaCell(cell: SpreadsheetCell | undefined): cell is SpreadsheetFormulaCell {
  return !!cell && typeof cell === 'object' && !Array.isArray(cell) && typeof cell.formula === 'string'
}

export function normalizeFormula(formula: string): string {
  return formula.trim().replace(/^=/u, '')
}
