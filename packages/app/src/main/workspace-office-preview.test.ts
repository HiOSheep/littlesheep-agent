import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { previewWorkspaceOfficeFile } from './workspace-office-preview.js'

describe('workspace Office previews', () => {
  it('returns bounded sheet rows for spreadsheets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-office-preview-'))
    try {
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['任务', '状态'],
        ['接入内部预览', '完成'],
      ]), '计划')
      const file = join(directory, 'plan.xlsx')
      await writeFile(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))

      const preview = await previewWorkspaceOfficeFile(file, '.xlsx')
      expect(preview.officeKind).toBe('spreadsheet')
      expect(preview.sections[0]?.rows).toEqual([
        ['任务', '状态'],
        ['接入内部预览', '完成'],
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('extracts slide text without exposing the original XML', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-office-preview-'))
    try {
      const zip = new JSZip()
      zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>第一张</a:t><a:t>内容</a:t></p:sld>')
      const file = join(directory, 'deck.pptx')
      await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))

      const preview = await previewWorkspaceOfficeFile(file, '.pptx')
      expect(preview.officeKind).toBe('presentation')
      expect(preview.sections[0]?.paragraphs).toEqual(['第一张 内容'])
      expect(JSON.stringify(preview)).not.toContain('<p:sld>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
