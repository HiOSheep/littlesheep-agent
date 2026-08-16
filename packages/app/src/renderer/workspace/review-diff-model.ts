// Rebuilds bounded unified-diff hunks into Monaco original/modified models.
import type { WorkspaceReviewDiffHunk, WorkspaceReviewDiffLayer } from '../api'

export interface WorkspaceReviewEditorModel {
  original: string
  modified: string
  originalLineNumber: (lineNumber: number) => string
  modifiedLineNumber: (lineNumber: number) => string
  originalSourceLine: (modelLineNumber: number) => number | null
  modifiedSourceLine: (modelLineNumber: number) => number | null
  originalModelLine: (sourceLineNumber: number) => number | null
  modifiedModelLine: (sourceLineNumber: number) => number | null
}

interface RebuiltSide {
  content: string
  lineNumbers: Array<number | null>
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
    originalSourceLine: sourceLineNumber(original.lineNumbers),
    modifiedSourceLine: sourceLineNumber(modified.lineNumbers),
    originalModelLine: modelLineNumber(original.lineNumbers),
    modifiedModelLine: modelLineNumber(modified.lineNumbers),
  }
}

function rebuildDiffSide(
  hunks: readonly WorkspaceReviewDiffHunk[],
  side: 'original' | 'modified',
): RebuiltSide {
  const content: string[] = []
  const lineNumbers: Array<number | null> = []
  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      content.push('')
      lineNumbers.push(null)
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

function displayLineNumber(lineNumbers: readonly (number | null)[]) {
  return (lineNumber: number): string => {
    const sourceLine = lineNumbers[lineNumber - 1]
    if (sourceLine !== null && sourceLine !== undefined) return String(sourceLine)
    return lineNumber > 1 && lineNumber < lineNumbers.length ? '...' : ''
  }
}

function sourceLineNumber(lineNumbers: readonly (number | null)[]) {
  return (modelLine: number): number | null => lineNumbers[modelLine - 1] ?? null
}

function modelLineNumber(lineNumbers: readonly (number | null)[]) {
  const modelLineBySourceLine = new Map<number, number>()
  lineNumbers.forEach((sourceLine, index) => {
    if (sourceLine !== null) modelLineBySourceLine.set(sourceLine, index + 1)
  })
  return (sourceLine: number): number | null => modelLineBySourceLine.get(sourceLine) ?? null
}
