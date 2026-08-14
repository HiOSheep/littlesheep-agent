import { mkdtempSync, rmSync } from 'node:fs'
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
