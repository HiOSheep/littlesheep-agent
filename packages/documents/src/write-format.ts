// Owns the stable mapping between creatable formats and filesystem extensions.
import { extname } from 'node:path'
import type { CreatableDocumentFormat } from './types.js'

export const EXTENSION_BY_FORMAT: Record<CreatableDocumentFormat, string> = {
  pdf: '.pdf',
  docx: '.docx',
  xlsx: '.xlsx',
  csv: '.csv',
}

export function formatFromExtension(filePath: string): CreatableDocumentFormat {
  const extension = extname(filePath).toLowerCase()
  const entry = Object.entries(EXTENSION_BY_FORMAT).find(([, value]) => value === extension)
  if (!entry) throw new Error(`无法根据扩展名判断可校验格式：${extension || '(无扩展名)'}`)
  return entry[0] as CreatableDocumentFormat
}
