// Path-aware adapter for the Documents-owned bounded Office preview parser.
import { readFile, stat } from 'node:fs/promises'
import {
  previewOfficeDocument,
  type OfficePreview,
  type OfficePreviewKind,
} from '@littlesheep/documents/office-preview'

export type WorkspaceOfficeKind = OfficePreviewKind
export type WorkspaceOfficeSection = OfficePreview['sections'][number]

export interface WorkspaceOfficePreview extends OfficePreview {
  kind: 'office'
}

export async function previewWorkspaceOfficeFile(
  filePath: string,
  extension: string,
): Promise<WorkspaceOfficePreview> {
  const fileInfo = await stat(filePath)
  const preview = await previewOfficeDocument({
    extension,
    byteLength: fileInfo.size,
    load: () => readFile(filePath),
  })
  return { kind: 'office', ...preview }
}
