// Generates readable A4 PDFs with Unicode font fallback and bounded table layout.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import PDFDocument from 'pdfkit'
import type { CreateDocumentInput, DocumentBlock } from './types.js'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 54
const BODY_WIDTH = PAGE_WIDTH - MARGIN * 2

export async function buildPdf(input: CreateDocumentInput): Promise<Buffer> {
  const chunks: Buffer[] = []
  const font = resolvePdfFont(collectDocumentText(input))
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
    info: { Title: input.title || 'LittleSheep document', Creator: 'LittleSheep' },
    font,
    autoFirstPage: true,
    bufferPages: true,
  })
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.once('end', () => resolve(Buffer.concat(chunks)))
    doc.once('error', reject)
  })

  doc.font(font)
  if (input.title) {
    doc.fontSize(22).fillColor('#111827').text(input.title, { width: BODY_WIDTH })
    doc.moveDown(0.35)
  }
  if (input.subtitle) {
    doc.fontSize(11).fillColor('#4B5563').text(input.subtitle, { width: BODY_WIDTH, lineGap: 2 })
    doc.moveDown(0.8)
  }
  doc.fillColor('#111827')
  for (const block of input.blocks ?? []) renderPdfBlock(doc, block, font)
  doc.end()
  return completed
}

function renderPdfBlock(doc: PDFKit.PDFDocument, block: DocumentBlock, font: string | undefined): void {
  switch (block.type) {
    case 'heading': {
      ensureSpace(doc, block.level === 1 ? 48 : 38)
      const size = block.level === 1 ? 17 : block.level === 3 ? 12 : 14
      doc.fontSize(size).fillColor('#1F4E79').text(block.text, { width: BODY_WIDTH })
      doc.moveDown(0.35)
      return
    }
    case 'paragraph':
      ensureSpace(doc, 28)
      doc.fontSize(10.5).fillColor('#111827').text(block.text, { width: BODY_WIDTH, lineGap: 3 })
      doc.moveDown(0.55)
      return
    case 'bullet_list':
    case 'numbered_list':
      block.items.forEach((item, index) => {
        ensureSpace(doc, 24)
        const marker = block.type === 'numbered_list' ? `${index + 1}.` : '-'
        doc.fontSize(10.5).fillColor('#111827').text(`${marker} ${item}`, {
          width: BODY_WIDTH - 12, indent: 12, lineGap: 2,
        })
      })
      doc.moveDown(0.5)
      return
    case 'table':
      renderTable(doc, block.rows, block.headerRows ?? 1, font)
      doc.moveDown(0.65)
      return
    case 'page_break':
      doc.addPage()
  }
}

function renderTable(
  doc: PDFKit.PDFDocument,
  rows: string[][],
  headerRows: number,
  font: string | undefined,
): void {
  if (rows.length === 0) return
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const columnWidth = BODY_WIDTH / columnCount
  const padding = 5
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const rowHeight = Math.max(22, ...Array.from({ length: columnCount }, (_value, columnIndex) => (
      doc.heightOfString(row[columnIndex] ?? '', { width: columnWidth - padding * 2, lineGap: 1 }) + padding * 2
    )))
    ensureSpace(doc, rowHeight + 1)
    const y = doc.y
    if (rowIndex < headerRows) doc.rect(MARGIN, y, BODY_WIDTH, rowHeight).fill('#EAF2F8')
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const x = MARGIN + columnIndex * columnWidth
      doc.rect(x, y, columnWidth, rowHeight).lineWidth(0.5).strokeColor('#9CA3AF').stroke()
      if (font) doc.font(font)
      doc.fontSize(rowIndex < headerRows ? 9.5 : 9).fillColor('#111827').text(
        row[columnIndex] ?? '', x + padding, y + padding,
        { width: columnWidth - padding * 2, height: rowHeight - padding * 2, lineGap: 1 },
      )
    }
    doc.y = y + rowHeight
    doc.x = MARGIN
  }
}

function ensureSpace(doc: PDFKit.PDFDocument, requiredHeight: number): void {
  if (doc.y + requiredHeight > PAGE_HEIGHT - MARGIN) doc.addPage()
}

function resolvePdfFont(text: string): string {
  const containsNonLatin = /[^\u0000-\u00ff]/u.test(text)
  const windowsFonts = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts'
  const candidates = [
    join(windowsFonts, 'NotoSansSC-VF.ttf'),
    join(windowsFonts, 'ARIALUNI.ttf'),
    join(windowsFonts, 'Deng.ttf'),
    join(windowsFonts, 'arial.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/Library/Fonts/Arial.ttf',
  ]
  const font = candidates.find((candidate) => existsSync(candidate))
  if (!font) {
    throw new Error(containsNonLatin
      ? '生成包含中文或其他非拉丁文字的 PDF 需要系统安装 Noto Sans CJK 或 Arial Unicode 字体。'
      : '生成 PDF 需要系统安装 Arial、DejaVu Sans 或其他受支持的 TrueType 字体。')
  }
  return font
}

function collectDocumentText(input: CreateDocumentInput): string {
  const chunks = [input.title ?? '', input.subtitle ?? '']
  for (const block of input.blocks ?? []) {
    if (block.type === 'table') chunks.push(...block.rows.flat())
    else if (block.type === 'bullet_list' || block.type === 'numbered_list') chunks.push(...block.items)
    else if (block.type !== 'page_break') chunks.push(block.text)
  }
  return chunks.join('\n')
}
