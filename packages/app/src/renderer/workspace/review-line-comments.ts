import type {
  AttachmentRef,
  WorkspaceReviewDiffLayerKind,
  WorkspaceReviewFile,
} from '../api'
import type { WorkspaceLineComment } from './line-comments'
import type { WorkspaceReviewEditorModel } from './review-diff-model'

export type WorkspaceReviewCommentSide = 'original' | 'modified'

export function workspaceFileLineCommentScope(root: string, path: string): string {
  return `${root}\u0000file\u0000${path}`
}

export function workspaceReviewLineCommentScope(
  root: string,
  path: string,
  layer: WorkspaceReviewDiffLayerKind,
  side: WorkspaceReviewCommentSide,
): string {
  return `${root}\u0000review\u0000${path}\u0000${layer}\u0000${side}`
}

export function buildWorkspaceReviewCommentAttachment({
  file,
  layer,
  side,
  model,
  comment,
}: {
  file: WorkspaceReviewFile
  layer: WorkspaceReviewDiffLayerKind
  side: WorkspaceReviewCommentSide
  model: WorkspaceReviewEditorModel
  comment: WorkspaceLineComment
}): AttachmentRef {
  const sourcePath = side === 'original' ? file.oldPath ?? file.path : file.path
  const sourceText = side === 'original' ? model.original : model.modified
  const toModelLine = side === 'original' ? model.originalModelLine : model.modifiedModelLine
  const sourceLines = sourceText.split('\n')
  const endLine = comment.endLine ?? comment.startLine
  const excerpt = Array.from({ length: endLine - comment.startLine + 1 }, (_, index) => {
    const sourceLine = comment.startLine + index
    const modelLine = toModelLine(sourceLine)
    return modelLine === null ? null : `${sourceLine} | ${sourceLines[modelLine - 1] ?? ''}`
  }).filter((line): line is string => line !== null)
  const layerLabel = layer === 'staged' ? '已暂存' : layer === 'unstaged' ? '未暂存' : '未跟踪'
  const sideLabel = side === 'original' ? '修改前' : '修改后'
  const reviewContext = [
    `Git 审阅上下文：${layerLabel} / ${sideLabel} / ${sourcePath}`,
    ...(excerpt.length > 0 ? ['所选源码：', ...excerpt] : []),
  ].join('\n')

  return {
    path: file.absolutePath,
    contextPath: sourcePath,
    name: sourcePath.split('/').at(-1) ?? sourcePath,
    kind: 'file',
    inlineText: reviewContext,
    lineComments: [{
      startLine: comment.startLine,
      ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
      text: `${comment.text}\n\n${reviewContext}`.slice(0, 4000),
    }],
  }
}
