export type ReadableDocumentFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'tsv'
  | 'pptx'

export type CreatableDocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'csv'

export interface DocumentSection {
  title: string
  paragraphs?: string[]
  rows?: string[][]
}

export type OfficePreviewKind = 'document' | 'spreadsheet' | 'presentation'

export interface OfficePreviewInput {
  extension: string
  byteLength: number
  load: () => Promise<Buffer>
}

export interface OfficePreview {
  officeKind: OfficePreviewKind
  sections: DocumentSection[]
  truncated: boolean
  note?: string
}

export interface ExtractedDocument {
  format: ReadableDocumentFormat
  sections: DocumentSection[]
  text: string
  truncated: boolean
  notes: string[]
  metadata: {
    bytes: number
    pageCount?: number
    sheetCount?: number
    slideCount?: number
  }
}

export interface ExtractDocumentOptions {
  maxBytes?: number
  maxChars?: number
  maxSections?: number
  maxRowsPerSheet?: number
  pageStart?: number
  pageEnd?: number
  sheetNames?: string[]
}

export type DocumentBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'numbered_list'; items: string[] }
  | { type: 'table'; rows: string[][]; headerRows?: number }
  | { type: 'page_break' }

export type SpreadsheetScalar = string | number | boolean | null

export interface SpreadsheetFormulaCell {
  value: Exclude<SpreadsheetScalar, null>
  formula: string
  numberFormat?: string
}

export type SpreadsheetCell = SpreadsheetScalar | SpreadsheetFormulaCell

export interface SpreadsheetSheet {
  name: string
  rows: SpreadsheetCell[][]
}

export interface CreateDocumentInput {
  filePath: string
  format: CreatableDocumentFormat
  title?: string
  subtitle?: string
  blocks?: DocumentBlock[]
  sheets?: SpreadsheetSheet[]
}

export interface CreatedDocument {
  filePath: string
  format: CreatableDocumentFormat
  bytes: number
  verification: string
}
