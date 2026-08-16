export interface LineCommentRange {
  startLine: number
  endLine: number
}

export interface LineSelectionSnapshot {
  startLineNumber: number
  endLineNumber: number
  endColumn: number
}

interface ResolveLineCommentGestureInput {
  didDrag: boolean
  pressedLine: number
  releasedLine: number | null
  selection: LineSelectionSnapshot | null
}

const LINE_COMMENT_DRAG_THRESHOLD_PX = 4

export function didLineCommentGestureDrag(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= LINE_COMMENT_DRAG_THRESHOLD_PX
}

export function resolveLineCommentGesture({
  didDrag,
  pressedLine,
  releasedLine,
  selection,
}: ResolveLineCommentGestureInput): LineCommentRange | null {
  if (!didDrag) {
    return releasedLine === pressedLine
      ? { startLine: pressedLine, endLine: pressedLine }
      : null
  }
  if (!selection) return null

  const startLine = selection.startLineNumber
  let endLine = selection.endLineNumber
  // Monaco selections are half-open, so column 1 does not include the final line.
  if (endLine > startLine && selection.endColumn === 1) endLine -= 1
  return endLine > startLine ? { startLine, endLine } : null
}
