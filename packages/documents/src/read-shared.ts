// Shared extraction result assembly and text normalization for all document readers.
import type { DocumentSection, ExtractedDocument, ReadableDocumentFormat } from './types.js'

export interface EffectiveReadLimits {
  maxChars: number
  maxSections: number
  maxRowsPerSheet: number
}

export function buildExtracted(
  format: ReadableDocumentFormat,
  sections: DocumentSection[],
  truncated: boolean,
  notes: string[],
  metadata: ExtractedDocument['metadata'],
): ExtractedDocument {
  return {
    format,
    sections,
    text: sections.map((section) => {
      const body = section.rows
        ? section.rows.map((row) => row.join('\t')).join('\n')
        : (section.paragraphs ?? []).join('\n')
      return `# ${section.title}\n${body}`.trim()
    }).filter(Boolean).join('\n\n'),
    truncated,
    notes,
    metadata,
  }
}

export function splitParagraphs(value: string): string[] {
  return value
    .replace(/\r\n?/gu, '\n')
    .split(/\n+/gu)
    .map((line) => line.trim())
    .filter(Boolean)
}
