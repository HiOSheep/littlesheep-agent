// Rebuilds bounded unified-diff hunks into Monaco original/modified models.
import type { WorkspaceReviewDiffHunk, WorkspaceReviewDiffLayer } from '../api'

export interface WorkspaceReviewEditorModel {
  original: string
  modified: string
  originalLineNumber: (lineNumber: number) => string
  modifiedLineNumber: (lineNumber: number) => string
}

interface RebuiltSide {
  content: string
  lineNumbers: Array<number | string>
}

export function buildWorkspaceReviewEditorModel(
  layer: Pick<WorkspaceReviewDiffLayer, 'hunks'>,
): WorkspaceReviewEditorModel {
  const original = rebuildDiffSide(layer.hunks, 'original')
  const modified = rebuildDiffSide(layer.hunks, 'modified')
  return {
    original: original.content,
    modified: modified.content,
    originalLineNumber: displayLineNumber(original.lineNumbers),
    modifiedLineNumber: displayLineNumber(modified.lineNumbers),
  }
}

function rebuildDiffSide(
  hunks: readonly WorkspaceReviewDiffHunk[],
  side: 'original' | 'modified',
): RebuiltSide {
  const content: string[] = []
  const lineNumbers: Array<number | string> = []
  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      content.push('')
      lineNumbers.push('...')
    }
    for (const line of hunk.lines) {
      const lineNumber = side === 'original' ? line.oldLine : line.newLine
      if (line.kind === 'meta' || lineNumber === null) continue
      content.push(line.content)
      lineNumbers.push(lineNumber)
    }
  })
  return { content: content.join('\n'), lineNumbers }
}

function displayLineNumber(lineNumbers: readonly (number | string)[]) {
  return (lineNumber: number): string => String(lineNumbers[lineNumber - 1] ?? '')
}
