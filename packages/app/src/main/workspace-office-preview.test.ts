import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocument } from '@littlesheep/documents'
import { describe, expect, it } from 'vitest'
import { previewWorkspaceOfficeFile } from './workspace-office-preview.js'

describe('workspace Office preview adapter', () => {
  it('loads an authorized path and maps the Documents result to the UI shape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-office-preview-'))
    try {
      const file = join(directory, 'plan.xlsx')
      await createDocument({
        filePath: file,
        format: 'xlsx',
        sheets: [{
          name: '计划',
          rows: [
            ['任务', '状态'],
            ['接入内部预览', '完成'],
          ],
        }],
      })

      const preview = await previewWorkspaceOfficeFile(file, '.xlsx')
      expect(preview.kind).toBe('office')
      expect(preview.officeKind).toBe('spreadsheet')
      expect(preview.sections[0]?.rows).toEqual([
        ['任务', '状态'],
        ['接入内部预览', '完成'],
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves a parser failure as structured Office preview metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-office-preview-'))
    try {
      const file = join(directory, 'deck.pptx')
      await writeFile(file, 'not a zip archive')

      const preview = await previewWorkspaceOfficeFile(file, '.pptx')
      expect(preview.kind).toBe('office')
      expect(preview.officeKind).toBe('presentation')
      expect(preview.sections).toEqual([])
      expect(preview.note).toMatch(/^内部预览失败：/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
