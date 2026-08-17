import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import {
  MAX_COLUMNS_PER_ROW,
  MAX_OFFICE_FILE_BYTES,
  MAX_PARAGRAPHS_PER_SECTION,
  MAX_PREVIEW_CHARS,
  MAX_ROWS_PER_SHEET,
  MAX_SECTIONS,
  MAX_XML_ENTRY_BYTES,
  previewOfficeDocument,
} from './office-preview.js'
import { readBoundedZipText } from './read-office-shared.js'
import { buildDocx } from './write-docx.js'

function source(buffer: Buffer, extension: string, byteLength = buffer.byteLength) {
  return {
    extension,
    byteLength,
    load: async () => buffer,
  }
}

function workbookBuffer(
  rows: unknown[][],
  bookType: 'xlsx' | 'biff8' = 'xlsx',
  sheetName = '计划',
): Buffer {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer
}

async function zipBuffer(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, value] of Object.entries(entries)) zip.file(name, value)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe('Office preview format matrix', () => {
  it('previews DOCX paragraphs without exposing a path capability', async () => {
    const buffer = await buildDocx({
      filePath: 'unused.docx',
      format: 'docx',
      title: '交付计划',
      blocks: [{ type: 'paragraph', text: '统一读取由 Documents 负责。' }],
    })

    const preview = await previewOfficeDocument(source(buffer, '.DOCX'))

    expect(preview.officeKind).toBe('document')
    expect(preview.sections[0]?.paragraphs?.join('\n')).toContain('统一读取由 Documents 负责')
    expect(preview.truncated).toBe(false)
  })

  it.each([
    { extension: '.xlsx', buffer: workbookBuffer([['任务', '状态'], ['统一预览', '完成']]) },
    { extension: '.xls', buffer: workbookBuffer([['任务', '状态'], ['旧表格', '可读']], 'biff8') },
    { extension: '.csv', buffer: Buffer.from('\uFEFF任务,状态\nCSV,可读\n', 'utf8') },
    { extension: '.tsv', buffer: Buffer.from('\uFEFF任务\t状态\nTSV\t可读\n', 'utf8') },
  ])('previews $extension as bounded spreadsheet rows', async ({ extension, buffer }) => {
    const preview = await previewOfficeDocument(source(buffer, extension))

    expect(preview.officeKind).toBe('spreadsheet')
    expect(preview.sections[0]?.rows?.[0]).toEqual(['任务', '状态'])
    expect(preview.sections[0]?.rows?.[1]?.[1]).toMatch(/完成|可读/u)
  })

  it('orders PPTX slides and returns decoded text instead of source XML', async () => {
    const buffer = await zipBuffer({
      'ppt/slides/slide2.xml': '<p:sld><a:t>第二张</a:t><a:t>&amp; 内容</a:t></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:t>第一张</a:t><a:t>内容</a:t></p:sld>',
    })

    const preview = await previewOfficeDocument(source(buffer, '.pptx'))

    expect(preview.officeKind).toBe('presentation')
    expect(preview.sections.map((section) => section.title)).toEqual(['幻灯片 1', '幻灯片 2'])
    expect(preview.sections[1]?.paragraphs).toEqual(['第二张 & 内容'])
    expect(JSON.stringify(preview)).not.toContain('<p:sld>')
  })

  it.each([
    { extension: '.odt', kind: 'document' },
    { extension: '.ods', kind: 'spreadsheet' },
    { extension: '.odp', kind: 'presentation' },
  ] as const)('previews $extension while preserving its current section shape', async ({ extension, kind }) => {
    const buffer = await zipBuffer({
      'content.xml': '<office:document><text:p>OpenDocument 内容</text:p></office:document>',
    })

    const preview = await previewOfficeDocument(source(buffer, extension))

    expect(preview.officeKind).toBe(kind)
    expect(preview.sections[0]?.paragraphs?.join(' ')).toContain('OpenDocument 内容')
    expect(preview.sections[0]?.rows).toBeUndefined()
  })

  it.each([
    { extension: '.doc', kind: 'document' },
    { extension: '.dot', kind: 'document' },
    { extension: '.ppt', kind: 'presentation' },
    { extension: '.pps', kind: 'presentation' },
    { extension: '.pot', kind: 'document' },
  ] as const)('keeps the legacy binary fallback for $extension', async ({ extension, kind }) => {
    const preview = await previewOfficeDocument(source(
      Buffer.from('binary\0LEGACY OFFICE TEXT\0payload', 'ascii'),
      extension,
    ))

    expect(preview.officeKind).toBe(kind)
    expect(preview.sections[0]?.title).toBe('可读取文本')
    expect(preview.sections[0]?.paragraphs).toContain('LEGACY OFFICE TEXT')
    expect(preview.note).toContain('安全提取')
  })
})

describe('Office preview budgets', () => {
  it('does not call the loader when the declared file size exceeds 24 MiB', async () => {
    let loaded = false
    const preview = await previewOfficeDocument({
      extension: '.docx',
      byteLength: MAX_OFFICE_FILE_BYTES + 1,
      load: async () => {
        loaded = true
        return Buffer.alloc(0)
      },
    })

    expect(loaded).toBe(false)
    expect(preview).toMatchObject({ officeKind: 'document', sections: [], truncated: true })
    expect(preview.note).toContain('24 MB')
  })

  it('checks the loaded size again when a file grows during reading', async () => {
    const preview = await previewOfficeDocument(source(
      Buffer.alloc(MAX_OFFICE_FILE_BYTES + 1),
      '.xlsx',
      1,
    ))

    expect(preview).toMatchObject({ officeKind: 'spreadsheet', sections: [], truncated: true })
    expect(preview.note).toContain('停止读取二进制内容')
  })

  it('bounds spreadsheet sections, rows, columns, and characters', async () => {
    const workbook = XLSX.utils.book_new()
    const rows = Array.from({ length: MAX_ROWS_PER_SHEET + 1 }, (_, row) => (
      Array.from({ length: MAX_COLUMNS_PER_ROW + 1 }, (_, column) => `${row}:${column}`)
    ))
    for (let index = 0; index < MAX_SECTIONS + 1; index += 1) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), `S${index + 1}`)
    }
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const preview = await previewOfficeDocument(source(buffer, '.xlsx'))

    expect(preview.sections).toHaveLength(MAX_SECTIONS)
    expect(preview.sections[0]?.rows).toHaveLength(MAX_ROWS_PER_SHEET)
    expect(preview.sections[0]?.rows?.every((row) => row.length <= MAX_COLUMNS_PER_ROW)).toBe(true)
    expect(preview.truncated).toBe(true)

    const csv = Buffer.from(`value\n${'x'.repeat(MAX_PREVIEW_CHARS + 1)}\n`, 'utf8')
    const characterPreview = await previewOfficeDocument(source(csv, '.csv'))
    const total = characterPreview.sections.flatMap((section) => section.rows ?? [])
      .flat().reduce((sum, cell) => sum + cell.length, 0)
    expect(total).toBe(MAX_PREVIEW_CHARS)
    expect(characterPreview.truncated).toBe(true)
  })

  it('bounds paragraphs within one section', async () => {
    const buffer = await buildDocx({
      filePath: 'unused.docx',
      format: 'docx',
      blocks: Array.from({ length: MAX_PARAGRAPHS_PER_SECTION + 1 }, (_, index) => ({
        type: 'paragraph' as const,
        text: `段落 ${index + 1}`,
      })),
    })

    const preview = await previewOfficeDocument(source(buffer, '.docx'))

    expect(preview.sections[0]?.paragraphs).toHaveLength(MAX_PARAGRAPHS_PER_SECTION)
    expect(preview.truncated).toBe(true)
  })
})

describe('Office preview hostile and damaged inputs', () => {
  it('stops OpenDocument parsing when a ZIP exceeds the entry budget', async () => {
    const zip = new JSZip()
    zip.file('content.xml', '<text:p>不应读取</text:p>')
    for (let index = 0; index < 4_096; index += 1) zip.file(`extra/${index}.xml`, '')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })

    const preview = await previewOfficeDocument(source(buffer, '.odt'))

    expect(preview).toMatchObject({ sections: [], truncated: true })
    expect(preview.note).toContain('条目过多')
  })

  it('skips XML whose declared uncompressed size exceeds the preview budget', async () => {
    const buffer = await zipBuffer({
      'content.xml': Buffer.alloc(MAX_XML_ENTRY_BYTES + 1, 0x61),
    })

    const preview = await previewOfficeDocument(source(buffer, '.odt'))

    expect(preview).toMatchObject({ sections: [], truncated: true })
    expect(preview.note).toContain('内容超过预览上限')
  })

  it('checks actual XML bytes even when an entry has no declared size', async () => {
    const zip = new JSZip()
    zip.file('content.xml', Buffer.alloc(1_025, 0x61))
    const entry = zip.file('content.xml')

    const result = await readBoundedZipText(entry!, 1_024)

    expect(result).toMatchObject({ oversized: true, actualBytes: 1_025 })
  })

  it('returns structured failures for damaged containers and an empty result for an empty DOCX', async () => {
    const damaged = await previewOfficeDocument(source(Buffer.from('not a zip'), '.pptx'))
    expect(damaged.sections).toEqual([])
    expect(damaged.truncated).toBe(false)
    expect(damaged.note).toMatch(/^内部预览失败：/u)

    const emptyBuffer = await buildDocx({
      filePath: 'unused.docx',
      format: 'docx',
      title: ' ',
    })
    const empty = await previewOfficeDocument(source(emptyBuffer, '.docx'))
    expect(empty.sections).toEqual([{ title: '正文', paragraphs: [] }])
    expect(empty.truncated).toBe(false)
  })
})
