// Generates styled A4 DOCX files with real headings, lists, and tables.
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { CreateDocumentInput, DocumentBlock } from './types.js'

const NUMBERING_REFERENCE = 'littlesheep-numbered-list'
const FONT = 'Microsoft YaHei'

export async function buildDocx(input: CreateDocumentInput): Promise<Buffer> {
  const children: Array<Paragraph | Table> = []
  if (input.title) {
    children.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 },
      children: [new TextRun({ text: input.title, bold: true, size: 40, font: FONT, color: '1F2937' })],
    }))
  }
  if (input.subtitle) {
    children.push(new Paragraph({
      spacing: { after: 260 },
      children: [new TextRun({ text: input.subtitle, size: 21, font: FONT, color: '4B5563' })],
    }))
  }
  for (const block of input.blocks ?? []) children.push(...renderBlock(block))

  const document = new Document({
    creator: 'LittleSheep',
    title: input.title,
    description: input.subtitle,
    numbering: {
      config: [{
        reference: NUMBERING_REFERENCE,
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    styles: {
      default: {
        document: { run: { font: FONT, size: 21, color: '111827' }, paragraph: { spacing: { after: 120, line: 300 } } },
        heading1: { run: { font: FONT, size: 32, bold: true, color: '1F4E79' }, paragraph: { spacing: { before: 260, after: 100 } } },
        heading2: { run: { font: FONT, size: 27, bold: true, color: '1F4E79' }, paragraph: { spacing: { before: 220, after: 80 } } },
        heading3: { run: { font: FONT, size: 23, bold: true, color: '374151' }, paragraph: { spacing: { before: 180, after: 60 } } },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11_906, height: 16_838 },
          margin: { top: 1_440, right: 1_440, bottom: 1_440, left: 1_440 },
        },
      },
      children,
    }],
  })
  return Packer.toBuffer(document)
}

function renderBlock(block: DocumentBlock): Array<Paragraph | Table> {
  switch (block.type) {
    case 'heading':
      return [new Paragraph({
        heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
        text: block.text,
      })]
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun({ text: block.text, font: FONT })] })]
    case 'bullet_list':
      return block.items.map((item) => new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: item, font: FONT })],
      }))
    case 'numbered_list':
      return block.items.map((item) => new Paragraph({
        numbering: { reference: NUMBERING_REFERENCE, level: 0 },
        children: [new TextRun({ text: item, font: FONT })],
      }))
    case 'table':
      return [buildTable(block.rows, block.headerRows ?? 1)]
    case 'page_break':
      return [new Paragraph({ children: [new PageBreak()] })]
  }
}

function buildTable(rows: string[][], headerRows: number): Table {
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const border = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' }
  const inside = { style: BorderStyle.SINGLE, size: 3, color: 'D1D5DB' }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border, bottom: border, left: border, right: border,
      insideHorizontal: inside, insideVertical: inside,
    },
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex < headerRows,
      children: Array.from({ length: columnCount }, (_value, columnIndex) => new TableCell({
        width: { size: Math.floor(100 / columnCount), type: WidthType.PERCENTAGE },
        margins: { top: 100, bottom: 100, left: 120, right: 120 },
        shading: rowIndex < headerRows
          ? { type: ShadingType.CLEAR, fill: 'EAF2F8', color: 'auto' }
          : undefined,
        children: [new Paragraph({
          children: [new TextRun({
            text: row[columnIndex] ?? '',
            font: FONT,
            bold: rowIndex < headerRows,
          })],
        })],
      })),
    })),
  })
}
