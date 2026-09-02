import type { AttachmentLineComment } from '../api'
import type { LineCommentRange } from './line-comment-gesture'

export type WorkspaceLineComment = AttachmentLineComment & { id: string; createdAt: number }

export type LineCommentDraftState = {
  editingRange: LineCommentRange | null
  draftText: string
  commentId?: string
  commentCreatedAt?: number
}

export type LineCommentDraftComment = {
  id: string
  createdAt: number
  text: string
}

export type LineCommentDraftAction =
  | { type: 'begin'; range: LineCommentRange; comment?: LineCommentDraftComment }
  | { type: 'change'; text: string }
  | { type: 'cancel' }

export interface LineCommentGutterLayout {
  lineNumbersLeft: number
  lineNumbersWidth: number
  decorationsLeft: number
  decorationsWidth: number
  contentLeft: number
}

export const EMPTY_LINE_COMMENT_DRAFT: LineCommentDraftState = { editingRange: null, draftText: '' }
export const LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT = 152
export const LINE_COMMENT_TEXTAREA_MIN_HEIGHT = 62
export const LINE_COMMENT_ADD_BUTTON_SIZE = 22

export function reduceLineCommentDraft(
  state: LineCommentDraftState,
  action: LineCommentDraftAction,
): LineCommentDraftState {
  if (action.type === 'begin') {
    return {
      editingRange: action.range,
      draftText: action.comment?.text ?? '',
      ...(action.comment ? {
        commentId: action.comment.id,
        commentCreatedAt: action.comment.createdAt,
      } : {}),
    }
  }
  if (action.type === 'change') {
    return state.draftText === action.text ? state : { ...state, draftText: action.text }
  }
  return state.editingRange === null
    && state.draftText === ''
    && state.commentId === undefined
    && state.commentCreatedAt === undefined
    ? state
    : EMPTY_LINE_COMMENT_DRAFT
}

export function createLineCommentFromDraft(
  state: LineCommentDraftState,
  identity: { id?: string; createdAt?: number } = {},
): WorkspaceLineComment | null {
  if (!state.editingRange) return null
  const text = state.draftText.trim()
  if (!text) return null
  return {
    id: identity.id ?? createCommentId(),
    startLine: state.editingRange.startLine,
    ...(state.editingRange.endLine === state.editingRange.startLine
      ? {} : { endLine: state.editingRange.endLine }),
    text,
    createdAt: identity.createdAt ?? Date.now(),
  }
}

export function sameLineCommentRange(left: LineCommentRange | null, right: LineCommentRange): boolean {
  return left?.startLine === right.startLine && left.endLine === right.endLine
}

export function resolveLineCommentAddButtonLeft(layout: LineCommentGutterLayout): number | null {
  const lineNumberRight = layout.lineNumbersLeft + layout.lineNumbersWidth
  const gutterLeft = Math.max(lineNumberRight, layout.decorationsLeft)
  const gutterRight = Math.min(layout.contentLeft, layout.decorationsLeft + layout.decorationsWidth)
  const gutterWidth = gutterRight - gutterLeft
  if (gutterWidth < LINE_COMMENT_ADD_BUTTON_SIZE) return null
  return gutterLeft + (gutterWidth - LINE_COMMENT_ADD_BUTTON_SIZE) / 2
}

export function createCommentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `line-comment-${crypto.randomUUID()}`
  }
  return `line-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function updateZoneHeight<T extends { key: string; height: number }>(
  zones: T[],
  key: string,
  height: number,
): T[] {
  const index = zones.findIndex((zone) => zone.key === key)
  if (index < 0 || zones[index]?.height === height) return zones
  const next = [...zones]
  next[index] = { ...next[index]!, height }
  return next
}

export function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function lineCommentZoneHeight(text: string): number {
  const estimatedLines = Math.max(1, Math.ceil(text.length / 72))
  return Math.min(132, 58 + estimatedLines * 18)
}

export function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`
}
