import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { createDocument, extractDocument, verifyDocument } from './index.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ls-documents-'))
  tempDirs.push(dir)
  return dir
}

describe('@littlesheep/documents', () => {
  it('creates and extracts a Chinese PDF with stable page metadata', async () => {
    const filePath = join(tempDir(), 'brief.pdf')
    const created = await createDocument({
      filePath,
      format: 'pdf',
      title: '项目简报',
      subtitle: 'LittleSheep 文档能力验证',
      blocks: [
        { type: 'heading', level: 1, text: '结论' },
        { type: 'paragraph', text: '这份 PDF 可以被重新打开并提取中文内容。' },
        { type: 'bullet_list', items: ['读取附件', '生成文件', '结构校验'] },
        { type: 'table', headerRows: 1, rows: [['项目', '状态'], ['PDF', '通过']] },
      ],
    })

    expect(created.bytes).toBeGreaterThan(1_000)
    expect(created.verification).toMatch(/1 页/u)
    const extracted = await extractDocument(filePath)
    expect(extracted.format).toBe('pdf')
    expect(extracted.metadata.pageCount).toBe(1)
    expect(extracted.text).toContain('项目简报')
    expect(extracted.text).toContain('重新打开')
  })

  it('creates and extracts DOCX paragraphs, lists and tables', async () => {
    const filePath = join(tempDir(), 'plan.docx')
    await createDocument({
      filePath,
      format: 'docx',
      title: '交付计划',
      blocks: [
        { type: 'paragraph', text: '按格式生成并验证。' },
        { type: 'numbered_list', items: ['读取', '生成', '校验'] },
        { type: 'table', rows: [['格式', '结果'], ['DOCX', '成功']] },
      ],
    })

    const extracted = await extractDocument(filePath)
    expect(extracted.text).toContain('交付计划')
    expect(extracted.text).toContain('按格式生成并验证')
    await expect(verifyDocument(filePath, 'docx')).resolves.toMatch(/DOCX 已重新打开/u)
  })

  it('preserves typed values and formulas in generated XLSX files', async () => {
    const filePath = join(tempDir(), 'budget.xlsx')
    await createDocument({
      filePath,
      format: 'xlsx',
      sheets: [{
        name: '预算',
        rows: [
          ['项目', '单价', '数量', '合计'],
          ['文档处理', 125.5, 2, { formula: 'B2*C2', value: 251, numberFormat: '#,##0.00' }],
        ],
      }],
    })

    const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer', cellFormula: true })
    expect(workbook.Sheets['预算']?.D2?.f).toBe('B2*C2')
    expect(workbook.Sheets['预算']?.B2?.v).toBe(125.5)
    const extracted = await extractDocument(filePath)
    expect(extracted.text).toContain('文档处理')
    expect(extracted.metadata.sheetCount).toBe(1)
  })

  it('creates UTF-8 CSV and reads it as structured rows', async () => {
    const filePath = join(tempDir(), 'data.csv')
    await createDocument({
      filePath,
      format: 'csv',
      sheets: [{ name: '数据', rows: [['名称', '数量'], ['中文', 3]] }],
    })

    expect(readFileSync(filePath).subarray(0, 3)).toEqual(Buffer.from([0xEF, 0xBB, 0xBF]))
    const extracted = await extractDocument(filePath)
    expect(extracted.sections[0]?.rows).toEqual([['名称', '数量'], ['中文', '3']])
  })

  it('rejects mismatched extensions and oversized values', async () => {
    await expect(createDocument({
      filePath: join(tempDir(), 'wrong.pdf'),
      format: 'docx',
      blocks: [{ type: 'paragraph', text: 'content' }],
    })).rejects.toThrow(/必须以 \.docx 结尾/u)

    await expect(createDocument({
      filePath: join(tempDir(), 'huge.csv'),
      format: 'csv',
      sheets: [{ name: '数据', rows: [[`x${'a'.repeat(32_000)}`]] }],
    })).rejects.toThrow(/单个文本值/u)

    await expect(createDocument({
      filePath: join(tempDir(), 'uncalculated.xlsx'),
      format: 'xlsx',
      sheets: [{ name: '模型', rows: [[{ formula: '1+1' } as never]] }],
    })).rejects.toThrow(/必须提供已核对的缓存结果/u)
  })
})
