// Coordinates validated document creation and post-write structural verification.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildDocx } from './write-docx.js'
import { buildPdf } from './write-pdf.js'
import { buildCsv, buildXlsx } from './write-spreadsheet.js'
import { validateCreateInput } from './write-validation.js'
import { verifyDocument, verifyPayload } from './verify.js'
import type { CreateDocumentInput, CreatedDocument } from './types.js'

export async function createDocument(input: CreateDocumentInput): Promise<CreatedDocument> {
  validateCreateInput(input)
  const payload = await buildPayload(input)
  await verifyPayload(payload, input.format, input)
  await mkdir(dirname(input.filePath), { recursive: true })
  await writeFile(input.filePath, payload)
  const verification = await verifyDocument(input.filePath, input.format)
  const fileInfo = await stat(input.filePath)
  return {
    filePath: input.filePath,
    format: input.format,
    bytes: fileInfo.size,
    verification,
  }
}

export { verifyDocument }

async function buildPayload(input: CreateDocumentInput): Promise<Buffer> {
  switch (input.format) {
    case 'pdf':
      return buildPdf(input)
    case 'docx':
      return buildDocx(input)
    case 'xlsx':
      return buildXlsx(input)
    case 'csv':
      return buildCsv(input)
  }
}
