import { resolve } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from '@littlesheep/types'
import { authorizeToolAccess } from '@littlesheep/safety'
import { parallelFilePolicy } from '../execution-policy.js'
import { sanitizeOutput, DEFAULT_SANITIZE } from '../sanitize.js'
import { withToolTiming } from '../wrapper.js'

const DocumentReadInput = z.object({
  file_path: z.string().min(1).describe('Absolute or workspace-relative path to PDF, DOCX, XLS/XLSX, CSV/TSV, or PPTX.'),
  page_start: z.number().int().positive().optional().describe('First PDF page to read (1-based).'),
  page_end: z.number().int().positive().optional().describe('Last PDF page to read (inclusive).'),
  sheet_names: z.array(z.string().min(1)).max(100).optional().describe('Optional workbook sheet names to read.'),
  max_chars: z.number().int().positive().max(100_000).optional().describe('Maximum extracted characters returned to the model.'),
})

export const documentReadTool: AgentTool = {
  name: 'document_read',
  description: 'Read structured content from PDF, Word DOCX, Excel XLS/XLSX, CSV/TSV, or PowerPoint PPTX files. Supports PDF page ranges and Excel sheet selection.',
  inputSchema: DocumentReadInput,
  execution: parallelFilePolicy('file_path', 'read'),
  execute: withToolTiming(async (input, ctx) => {
    const parsed = DocumentReadInput.parse(input)
    if (parsed.page_start && parsed.page_end && parsed.page_end < parsed.page_start) {
      return { ok: false, error: 'page_end must be greater than or equal to page_start.' }
    }
    const targetPath = resolve(ctx.cwd, parsed.file_path)
    const authorization = await authorizeToolAccess('document_read', { file_path: targetPath }, ctx)
    if (!authorization.allowed) {
      return { ok: false, error: 'Approval denied: reading this document requires user approval.' }
    }
    const { extractDocument } = await import('@littlesheep/documents')
    const extracted = await extractDocument(targetPath, {
      pageStart: parsed.page_start,
      pageEnd: parsed.page_end,
      sheetNames: parsed.sheet_names,
      maxChars: parsed.max_chars ?? 60_000,
    })
    if (!extracted.text.trim()) {
      return {
        ok: false,
        error: [
          `No readable text was extracted from ${targetPath}.`,
          ...extracted.notes,
        ].join('\n'),
        meta: {
          filePath: targetPath,
          format: extracted.format,
          contentAvailable: false,
          ...extracted.metadata,
        },
      }
    }
    const header = [
      `Document: ${targetPath}`,
      `Format: ${extracted.format}`,
      `Bytes: ${extracted.metadata.bytes}`,
      ...(extracted.metadata.pageCount ? [`Pages: ${extracted.metadata.pageCount}`] : []),
      ...(extracted.metadata.sheetCount ? [`Sheets: ${extracted.metadata.sheetCount}`] : []),
      ...(extracted.metadata.slideCount ? [`Slides: ${extracted.metadata.slideCount}`] : []),
      `Truncated: ${extracted.truncated ? 'yes' : 'no'}`,
      ...extracted.notes.map((note) => `Note: ${note}`),
      '',
      extracted.text,
    ]
    const sanitized = sanitizeOutput(header.join('\n'), {
      ...DEFAULT_SANITIZE,
      maxOutputChars: parsed.max_chars ?? 60_000,
    })
    return {
      output: sanitized.output,
      sanitized: sanitized.sanitized,
      meta: {
        filePath: targetPath,
        format: extracted.format,
        truncated: extracted.truncated || sanitized.truncated,
        sections: extracted.sections.length,
        ...extracted.metadata,
      },
    }
  }),
}
