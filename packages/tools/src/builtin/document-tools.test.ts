import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@littlesheep/types'
import { asSessionId } from '@littlesheep/types'
import { documentCreateTool } from './document-create.js'
import { documentReadTool } from './document-read.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'ls-document-tools-'))
  tempDirs.push(dir)
  return {
    dir,
    ctx: {
      sessionId: asSessionId('document-session'),
      runId: 'document-run',
      cwd: dir,
      containerRoot: dir,
      permissionMode: 'full',
    },
  }
}

function writeTextlessPdf(filePath: string): void {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(content, 'ascii'))
    content += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content, 'ascii')
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  writeFileSync(filePath, content, 'ascii')
}

describe('document tools', () => {
  it('creates a verified PDF and reads it through the structured reader', async () => {
    const { dir, ctx } = fixture()
    const filePath = join(dir, 'deliverable.pdf')
    const beforeFileMutation = vi.fn(async () => undefined)
    ctx.versioning = { beforeFileMutation, beforeWorkspaceMutation: vi.fn(async () => undefined) }

    const created = await documentCreateTool.execute({
      file_path: filePath,
      format: 'pdf',
      title: '常规文件能力',
      blocks: [{ type: 'paragraph', text: 'PDF 已生成并经过结构校验。' }],
    }, ctx)

    expect(created.ok).toBe(true)
    expect(created.meta).toMatchObject({ artifactPath: filePath, artifactFormat: 'pdf', verified: true })
    expect(beforeFileMutation).toHaveBeenCalledWith(filePath)

    const read = await documentReadTool.execute({ file_path: filePath }, ctx)
    expect(read.ok).toBe(true)
    expect(String(read.output)).toContain('PDF 已生成')
    expect(read.meta).toMatchObject({ format: 'pdf', pageCount: 1 })
  })

  // RS-03: document_create creates new files only; it never replaces a document.
  it('refuses to replace an existing document and leaves it untouched', async () => {
    const { dir, ctx } = fixture()
    const filePath = join(dir, 'already-there.pdf')
    writeTextlessPdf(filePath)
    const before = readFileSync(filePath)

    const result = await documentCreateTool.execute({
      file_path: filePath,
      format: 'pdf',
      title: 'replacement',
      blocks: [{ type: 'paragraph', text: 'this must not be written' }],
    }, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta).toMatchObject({ errorKind: 'target_exists' })
    expect(result.error).toMatch(/only creates new files/)
    expect(readFileSync(filePath).equals(before)).toBe(true)
  })

  it('still creates a document at a fresh path', async () => {
    const { dir, ctx } = fixture()
    const filePath = join(dir, 'fresh.csv')

    const result = await documentCreateTool.execute({
      file_path: filePath,
      format: 'csv',
      sheets: [{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }],
    }, ctx)

    expect(result.ok).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toContain('a,b')
  })

  it('creates XLSX formula cells and exposes their calculated values on read', async () => {
    const { dir, ctx } = fixture()
    const filePath = join(dir, 'model.xlsx')
    const created = await documentCreateTool.execute({
      file_path: filePath,
      format: 'xlsx',
      sheets: [{
        name: '模型',
        rows: [
          ['单价', '数量', '合计'],
          [12.5, 4, { formula: 'A2*B2', value: 50, numberFormat: '#,##0.00' }],
        ],
      }],
    }, ctx)
    expect(created.ok).toBe(true)

    const read = await documentReadTool.execute({ file_path: filePath, sheet_names: ['模型'] }, ctx)
    expect(read.ok).toBe(true)
    expect(String(read.output)).toContain('12.5\t4\t50.00')
  })

  it('rejects formula cells without a verified cached result', async () => {
    const { dir, ctx } = fixture()
    const result = await documentCreateTool.execute({
      file_path: join(dir, 'uncalculated.xlsx'),
      format: 'xlsx',
      sheets: [{ name: '模型', rows: [[{ formula: '1+1' }]] }],
    }, ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('value')
  })

  it('reports OCR and legacy Office conversion requirements as read failures', async () => {
    const { dir, ctx } = fixture()
    const scanPath = join(dir, 'scan.pdf')
    writeTextlessPdf(scanPath)

    const scan = await documentReadTool.execute({ file_path: scanPath }, ctx)
    expect(scan.ok).toBe(false)
    expect(scan.error).toMatch(/OCR/u)
    expect(scan.meta).toMatchObject({ format: 'pdf', contentAvailable: false, pageCount: 1 })

    const legacy = await documentReadTool.execute({ file_path: join(dir, 'legacy.doc') }, ctx)
    expect(legacy.ok).toBe(false)
    expect(legacy.error).toMatch(/DOCX.*PPTX/u)
  })

  it('uses the permission boundary for reads and writes', async () => {
    const { dir, ctx } = fixture()
    ctx.permissionMode = 'restricted'
    ctx.approve = vi.fn(async () => false)

    const deniedCreate = await documentCreateTool.execute({
      file_path: join(dir, 'denied.docx'),
      format: 'docx',
      blocks: [{ type: 'paragraph', text: 'no' }],
    }, ctx)
    expect(deniedCreate).toMatchObject({ ok: false, error: 'Approval denied' })

    const deniedRead = await documentReadTool.execute({ file_path: join(dir, 'missing.pdf') }, ctx)
    expect(deniedRead.ok).toBe(false)
    expect(deniedRead.error).toMatch(/requires user approval/u)
  })
})
