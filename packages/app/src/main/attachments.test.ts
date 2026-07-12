import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  classifyAttachment,
  composeRunText,
  importAttachmentData,
  parseAttachments,
  prepareRunAttachments,
} from './attachments.js'

describe('main attachment helpers', () => {
  it('parses and injects text attachment previews', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-'))
    try {
      const file = join(dir, 'notes.md')
      writeFileSync(file, '# Notes\nhello from the file', 'utf8')
      const refs = parseAttachments([{ path: file, name: 'notes.md' }])
      const attachments = await prepareRunAttachments(refs)
      const text = await composeRunText('summarize this', attachments)
      expect(text).toContain('notes.md')
      expect(text).toContain('# Notes')
      expect(text).toContain('hello from the file')
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
      const text = await composeRunText('read workbook', prepared)
      expect(text).toContain('# Sheet: Plan')
      expect(text).toContain('Task\tOwner')
      expect(text).toContain('Ship parser\tLittleSheep')
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
      const text = await composeRunText('inspect pdf', prepared)
      expect(text).toContain('paper.pdf')
      expect(text).toContain('PDF text extraction is not enabled yet')
      expect(text).not.toContain('%PDF-1.4 fake')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports pasted data-url attachments into workplace attachments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-att-import-'))
    try {
      const file = await importAttachmentData(dir, {
        name: 'paste.png',
        dataUrl: `data:image/png;base64,${Buffer.from('fake png').toString('base64')}`,
      })
      expect(file.name).toMatch(/paste\.png$/)
      expect(file.path).toContain('attachments')
      expect(file.kind).toBe('image')
      expect(file.size).toBe(Buffer.byteLength('fake png'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
