import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { InlineDeletedLineTarget } from './review-inline-deleted-line-numbers'
import { resolveDeletedLineRange } from './review-inline-deleted-comments'

describe('review line comment integration', () => {
  it('uses one shared comment overlay for both visible diff editors and a view-zone adapter for inline deletions', async () => {
    const diffSource = await readFile(new URL('./review-diff.tsx', import.meta.url), 'utf8')
    const panelSource = await readFile(new URL('./panel.tsx', import.meta.url), 'utf8')
    const previewSource = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')
    const commentSource = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')
    const deletedSource = await readFile(new URL('./review-inline-deleted-comments.tsx', import.meta.url), 'utf8')
    const surfaceSource = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')

    expect(diffSource.split('<WorkspaceLineCommentOverlay').length - 1).toBe(2)
    expect(diffSource).toContain('<WorkspaceReviewInlineDeletedComments')
    expect(diffSource).toContain("workspaceReviewLineCommentScope(workspacePath, file.path, layer.kind, 'original')")
    expect(diffSource).toContain("workspaceReviewLineCommentScope(workspacePath, file.path, layer.kind, 'modified')")
    expect(diffSource).toContain('setInlineDeletedTargets')
    expect(panelSource).toContain('lineCommentsByScope={lineCommentsByScope}')
    expect(panelSource).toContain('onLineCommentsChange={updateLineComments}')
    expect(panelSource).toContain('onAddAttachment={onAddAttachment}')
    expect(diffSource).toContain('const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []')
    expect(panelSource).toContain('const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []')
    expect(previewSource).toContain('const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []')
    expect(diffSource).not.toContain('?? []')
    expect(panelSource).not.toContain('?? []')
    expect(previewSource).not.toContain('comments={comments ?? []}')
    expect(surfaceSource.split('export function LineCommentEditor(').length - 1).toBe(1)
    expect(surfaceSource.split('export function LineCommentCard(').length - 1).toBe(1)
    expect(surfaceSource).toContain('aria-label="编辑评论"')
    expect(surfaceSource).toContain('aria-label="删除评论"')
    expect(commentSource).toContain('onCommentUpdate')
    expect(commentSource).toContain('onCommentDelete')
    expect(deletedSource).toContain('onCommentUpdate')
    expect(deletedSource).toContain('onCommentDelete')
    expect(commentSource).toContain('<LineCommentEditor')
    expect(deletedSource).toContain('<LineCommentEditor')
    expect(commentSource).not.toContain('className="workspace-line-comment-editor"')
    expect(deletedSource).not.toContain('className="workspace-line-comment-editor"')
    expect(commentSource).toContain('mapModelRangeToSource')
    expect(commentSource).toContain('afterLineNumber: modelEndLine')
    expect(deletedSource).toContain('resolveDeletedLineRange')
    expect(deletedSource).toContain('afterLineNumber: targetMap.get(range.endLine)!.modifiedAnchorModelLine')
  })

  it('opens contiguous deleted rows on click or drag and rejects gaps', () => {
    const targets = new Map<number, InlineDeletedLineTarget>([
      [5, target(5)],
      [6, target(6)],
      [7, target(7)],
      [10, target(10)],
    ])

    expect(resolveDeletedLineRange(5, 5, false, targets)).toEqual({ startLine: 5, endLine: 5 })
    expect(resolveDeletedLineRange(7, 5, true, targets)).toEqual({ startLine: 5, endLine: 7 })
    expect(resolveDeletedLineRange(5, 5, true, targets)).toBeNull()
    expect(resolveDeletedLineRange(7, 10, true, targets)).toBeNull()
  })
})

function target(sourceLineNumber: number): InlineDeletedLineTarget {
  return {
    originalModelLineNumber: sourceLineNumber,
    sourceLineNumber,
    sourceLine: `line ${sourceLineNumber}`,
    top: sourceLineNumber * 23,
    height: 23,
    modifiedAnchorModelLine: 1,
    contentZone: {} as HTMLElement,
  }
}
