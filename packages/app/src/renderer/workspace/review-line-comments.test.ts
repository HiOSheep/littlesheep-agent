import { describe, expect, it } from 'vitest'
import type { WorkspaceReviewFile } from '../api'
import { buildWorkspaceReviewEditorModel } from './review-diff-model'
import {
  buildWorkspaceReviewCommentAttachment,
  workspaceFileLineCommentScope,
  workspaceReviewLineCommentScope,
} from './review-line-comments'

describe('workspace review line comments', () => {
  it('isolates ordinary files and every review layer side', () => {
    const ordinary = workspaceFileLineCommentScope('D:\\repo', 'src/app.ts')
    const stagedOriginal = workspaceReviewLineCommentScope('D:\\repo', 'src/app.ts', 'staged', 'original')
    const stagedModified = workspaceReviewLineCommentScope('D:\\repo', 'src/app.ts', 'staged', 'modified')
    const unstagedOriginal = workspaceReviewLineCommentScope('D:\\repo', 'src/app.ts', 'unstaged', 'original')

    expect(new Set([ordinary, stagedOriginal, stagedModified, unstagedOriginal]).size).toBe(4)
  })

  it('includes the exact review side, path, source lines, and user text in the attachment', () => {
    const model = buildWorkspaceReviewEditorModel({ hunks: [{
      header: '@@ -20,2 +20,2 @@',
      oldStart: 20,
      oldLines: 2,
      newStart: 20,
      newLines: 2,
      lines: [
        { kind: 'deletion', content: 'return oldValue', oldLine: 20, newLine: null },
        { kind: 'addition', content: 'return newValue', oldLine: null, newLine: 20 },
        { kind: 'context', content: '}', oldLine: 21, newLine: 21 },
      ],
    }] })
    const attachment = buildWorkspaceReviewCommentAttachment({
      file: reviewFile(),
      layer: 'unstaged',
      side: 'original',
      model,
      comment: {
        id: 'comment-1',
        startLine: 20,
        text: '保留旧分支的兼容行为。',
        createdAt: 1,
      },
    })

    expect(attachment).toMatchObject({
      path: 'D:\\repo\\src\\app.ts',
      contextPath: 'src/old-app.ts',
      name: 'old-app.ts',
      kind: 'file',
    })
    expect(attachment.lineComments?.[0]).toMatchObject({ id: 'comment-1', startLine: 20 })
    expect(attachment.lineComments?.[0]?.text).toContain('保留旧分支的兼容行为。')
    expect(attachment.lineComments?.[0]?.text).toContain('未暂存 / 修改前 / src/old-app.ts')
    expect(attachment.lineComments?.[0]?.text).toContain('20 | return oldValue')
    expect(attachment.inlineText).toContain('20 | return oldValue')
  })
})

function reviewFile(): WorkspaceReviewFile {
  return {
    path: 'src/app.ts',
    absolutePath: 'D:\\repo\\src\\app.ts',
    oldPath: 'src/old-app.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    countAvailable: true,
    staged: false,
    unstaged: true,
    binary: false,
  }
}
