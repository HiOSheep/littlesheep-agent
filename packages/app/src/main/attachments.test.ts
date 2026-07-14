import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { asSessionId } from '@littlesheep/types'
import {
  classifyAttachment,
  createInspectAttachmentTool,
  parseAttachments,
  prepareRunAttachments,
} from './attachments.js'

describe('main attachment helpers', () => {
  it('keeps document content uninspected until the scoped tool reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-'))
    try {
      const file = join(dir, 'notes.md')
      writeFileSync(file, '# Notes\nhello from the file', 'utf8')
      const refs = parseAttachments([{ path: file, name: 'notes.md' }])
      const attachments = await prepareRunAttachments(refs)
      expect(attachments[0]?.extractedText).toBeUndefined()
      expect(attachments[0]).toMatchObject({ ownership: 'external', contentState: 'uninspected' })

      const tool = createInspectAttachmentTool(attachments)
      expect(tool?.name).toBe('inspect_attachment')
      const result = await tool!.execute(
        { attachment_id: attachments[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(String(result.output)).toContain('hello from the file')
      expect(attachments[0]).toMatchObject({ contentState: 'loaded' })
      expect(attachments[0]?.extractedText).toContain('hello from the file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts workbook sheet text from xlsx attachments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-xlsx-'))
    try {
      const file = join(dir, 'tasks.xlsx')
      const workbook = XLSX.utils.book_new()
      const sheet = XLSX.utils.aoa_to_sheet([
        ['Task', 'Owner'],
        ['Ship parser', 'LittleSheep'],
      ])
      XLSX.utils.book_append_sheet(workbook, sheet, 'Plan')
      XLSX.writeFile(workbook, file)

      const attachment = await classifyAttachment(file)
      const prepared = await prepareRunAttachments([attachment])
      expect(prepared[0]?.contentState).toBe('uninspected')
      const tool = createInspectAttachmentTool(prepared)!
      const result = await tool.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(prepared[0]?.extractedText).toContain('Task\tOwner')
      expect(prepared[0]?.extractedText).toContain('Ship parser\tLittleSheep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps pdf path context when pdf text extraction is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-pdf-'))
    try {
      const file = join(dir, 'paper.pdf')
      writeFileSync(file, '%PDF-1.4 fake', 'utf8')
      const prepared = await prepareRunAttachments([await classifyAttachment(file)])
      expect(prepared[0]?.contentState).toBe('uninspected')
      const tool = createInspectAttachmentTool(prepared)!
      const result = await tool.execute(
        { attachment_id: prepared[0]!.id },
        { sessionId: asSessionId('session-1'), runId: 'run-1', cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(String(result.output)).toContain('PDF text extraction is not enabled yet')
      expect(prepared[0]?.contentState).toBe('unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies selected files by the workspace boundary without trusting client ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-ownership-'))
    try {
      const workplace = join(dir, 'workplace')
      const project = join(dir, 'project')
      const external = join(dir, 'external.txt')
      const workplaceFile = join(workplace, 'user-note.txt')
      const projectFile = join(project, 'spec.md')
      mkdirSync(workplace, { recursive: true })
      mkdirSync(project, { recursive: true })
      writeFileSync(workplaceFile, 'workplace', { encoding: 'utf8', flag: 'w' })
      writeFileSync(projectFile, 'project', { encoding: 'utf8', flag: 'w' })
      writeFileSync(external, 'external', 'utf8')

      const prepared = await prepareRunAttachments([
        { path: workplaceFile, ownership: 'cache' },
        { path: projectFile },
        { path: external },
      ], {
        workplaceDir: workplace,
        workspaceDir: project,
        projectId: 'project-1',
      })

      expect(prepared.map((item) => item.ownership)).toEqual([
        'user_workplace',
        'project',
        'external',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
