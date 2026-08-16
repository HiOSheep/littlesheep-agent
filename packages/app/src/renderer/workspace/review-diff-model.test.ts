import { describe, expect, it } from 'vitest'
import type { WorkspaceReviewDiffHunk } from '../api'
import { buildWorkspaceReviewEditorModel } from './review-diff-model'

describe('workspace review Monaco model', () => {
  it('rebuilds original and modified code while retaining source line numbers', () => {
    const model = buildWorkspaceReviewEditorModel({ hunks: [hunk({
      header: '@@ -10,3 +10,3 @@',
      oldStart: 10,
      newStart: 10,
      lines: [
        { kind: 'context', content: 'const answer = 42', oldLine: 10, newLine: 10 },
        { kind: 'deletion', content: 'return oldValue', oldLine: 11, newLine: null },
        { kind: 'addition', content: 'return newValue', oldLine: null, newLine: 11 },
        { kind: 'context', content: '}', oldLine: 12, newLine: 12 },
      ],
    })] })

    expect(model.original).toBe('const answer = 42\nreturn oldValue\n}')
    expect(model.modified).toBe('const answer = 42\nreturn newValue\n}')
    expect([1, 2, 3].map(model.originalLineNumber)).toEqual(['10', '11', '12'])
    expect([1, 2, 3].map(model.modifiedLineNumber)).toEqual(['10', '11', '12'])
    expect([1, 2, 3].map(model.originalSourceLine)).toEqual([10, 11, 12])
    expect([10, 11, 12].map(model.originalModelLine)).toEqual([1, 2, 3])
  })

  it('separates distant hunks without inventing source line numbers', () => {
    const model = buildWorkspaceReviewEditorModel({ hunks: [
      hunk({
        header: '@@ -1 +1 @@',
        oldStart: 1,
        newStart: 1,
        lines: [{ kind: 'context', content: 'first', oldLine: 1, newLine: 1 }],
      }),
      hunk({
        header: '@@ -90 +90 @@',
        oldStart: 90,
        newStart: 90,
        lines: [{ kind: 'context', content: 'last', oldLine: 90, newLine: 90 }],
      }),
    ] })

    expect(model.original).toBe('first\n\nlast')
    expect([1, 2, 3].map(model.originalLineNumber)).toEqual(['1', '...', '90'])
    expect([1, 2, 3].map(model.originalSourceLine)).toEqual([1, null, 90])
    expect([1, 50, 90].map(model.originalModelLine)).toEqual([1, null, 3])
    expect(model.modified).toBe('first\n\nlast')
    expect([1, 2, 3].map(model.modifiedLineNumber)).toEqual(['1', '...', '90'])
  })
})

function hunk(input: {
  header: string
  oldStart: number
  newStart: number
  lines: WorkspaceReviewDiffHunk['lines']
}): WorkspaceReviewDiffHunk {
  return {
    ...input,
    oldLines: input.lines.filter((line) => line.oldLine !== null).length,
    newLines: input.lines.filter((line) => line.newLine !== null).length,
  }
}
