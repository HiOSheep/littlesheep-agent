import { resolve } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from '@littlesheep/types'
import { authorizeToolAccess } from '@littlesheep/safety'
import { parallelFilePolicy } from '../execution-policy.js'
import { CORE_SOURCE_READ_ONLY_ERROR, findProtectedWriteRoot } from '../path-protection.js'
import { withToolTiming } from '../wrapper.js'

const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
const FormulaCell = z.object({
  formula: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]).describe('Required verified cached result; document_create does not calculate Excel formulas.'),
  numberFormat: z.string().max(128).optional(),
})
const SheetCell = z.union([CellValue, FormulaCell])
const DocumentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  z.object({ type: z.literal('paragraph'), text: z.string() }),
  z.object({ type: z.literal('bullet_list'), items: z.array(z.string()) }),
  z.object({ type: z.literal('numbered_list'), items: z.array(z.string()) }),
  z.object({ type: z.literal('table'), rows: z.array(z.array(z.string())), headerRows: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('page_break') }),
])
const DocumentCreateInput = z.object({
  file_path: z.string().min(1).describe('Output path ending in .pdf, .docx, .xlsx, or .csv.'),
  format: z.enum(['pdf', 'docx', 'xlsx', 'csv']),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  blocks: z.array(DocumentBlock).max(2_000).optional().describe('Ordered rich-text blocks for PDF or DOCX.'),
  sheets: z.array(z.object({
    name: z.string().min(1).max(31),
    rows: z.array(z.array(SheetCell)),
  })).max(100).optional().describe('Worksheet data for XLSX or one sheet for CSV. Formula cells require both formula and a verified cached value.'),
})

export const documentCreateTool: AgentTool = {
  name: 'document_create',
  description: 'Create and structurally verify PDF, DOCX, XLSX, or CSV files. Use blocks for documents and typed rows/formula cells with verified cached results for spreadsheets.',
  inputSchema: DocumentCreateInput,
  requiresApproval: true,
  execution: parallelFilePolicy('file_path', 'write'),
  execute: withToolTiming(async (input, ctx) => {
    const parsed = DocumentCreateInput.parse(input)
    const targetPath = resolve(ctx.cwd, parsed.file_path)
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx)
    if (protectedRoot) return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: ${targetPath}` }
    const authorization = await authorizeToolAccess('document_create', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    })
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' }

    await ctx.versioning?.beforeFileMutation(targetPath)
    const { createDocument } = await import('@littlesheep/documents')
    const created = await createDocument({
      filePath: targetPath,
      format: parsed.format,
      title: parsed.title,
      subtitle: parsed.subtitle,
      blocks: parsed.blocks,
      sheets: parsed.sheets,
    })
    ctx.log?.('info', `created ${created.format} ${targetPath} (${created.bytes} bytes)`)
    return {
      output: [
        `Created ${created.format.toUpperCase()}: ${created.filePath}`,
        `Bytes: ${created.bytes}`,
        `Verification: ${created.verification}`,
      ].join('\n'),
      meta: {
        artifactPath: created.filePath,
        artifactFormat: created.format,
        bytes: created.bytes,
        verified: true,
      },
    }
  }),
}
