import { describe, expect, it } from 'vitest'
import {
  createLineCommentFromDraft,
  EMPTY_LINE_COMMENT_DRAFT,
  reduceLineCommentDraft,
} from './line-comment-model'

describe('line comment model', () => {
  it('begins a fresh draft and applies text changes', () => {
    const begun = reduceLineCommentDraft(EMPTY_LINE_COMMENT_DRAFT, {
      type: 'begin',
      range: { startLine: 4, endLine: 7 },
    })
    const changed = reduceLineCommentDraft(begun, { type: 'change', text: 'explain this change' })

    expect(begun).toEqual({ editingRange: { startLine: 4, endLine: 7 }, draftText: '' })
    expect(changed).toEqual({
      editingRange: { startLine: 4, endLine: 7 },
      draftText: 'explain this change',
    })
    expect(reduceLineCommentDraft(changed, { type: 'change', text: changed.draftText })).toBe(changed)
  })

  it('cancels a populated draft and keeps an empty cancellation idempotent', () => {
    const populated = {
      editingRange: { startLine: 11, endLine: 11 },
      draftText: 'draft',
    }

    expect(reduceLineCommentDraft(populated, { type: 'cancel' })).toBe(EMPTY_LINE_COMMENT_DRAFT)
    expect(reduceLineCommentDraft(EMPTY_LINE_COMMENT_DRAFT, { type: 'cancel' }))
      .toBe(EMPTY_LINE_COMMENT_DRAFT)
  })

  it('rejects blank publication', () => {
    expect(createLineCommentFromDraft({
      editingRange: { startLine: 3, endLine: 3 },
      draftText: ' \n\t ',
    }, { id: 'comment-blank', createdAt: 10 })).toBeNull()
  })

  it('trims a single-line publication and uses deterministic identity', () => {
    expect(createLineCommentFromDraft({
      editingRange: { startLine: 3, endLine: 3 },
      draftText: '  preserve this branch  ',
    }, { id: 'comment-3', createdAt: 123 })).toEqual({
      id: 'comment-3',
      startLine: 3,
      text: 'preserve this branch',
      createdAt: 123,
    })
  })

  it('preserves the end line for a multi-line publication', () => {
    expect(createLineCommentFromDraft({
      editingRange: { startLine: 8, endLine: 12 },
      draftText: 'covers the whole replacement',
    }, { id: 'comment-8-12', createdAt: 456 })).toEqual({
      id: 'comment-8-12',
      startLine: 8,
      endLine: 12,
      text: 'covers the whole replacement',
      createdAt: 456,
    })
  })

  it('starts an edit draft with the original identity and text', () => {
    const edited = reduceLineCommentDraft(EMPTY_LINE_COMMENT_DRAFT, {
      type: 'begin',
      range: { startLine: 5, endLine: 6 },
      comment: { id: 'comment-5', createdAt: 123, text: 'existing comment' },
    })

    expect(edited).toEqual({
      editingRange: { startLine: 5, endLine: 6 },
      draftText: 'existing comment',
      commentId: 'comment-5',
      commentCreatedAt: 123,
    })
    expect(createLineCommentFromDraft(edited, {
      id: edited.commentId,
      createdAt: edited.commentCreatedAt,
    })).toEqual({
      id: 'comment-5',
      startLine: 5,
      endLine: 6,
      text: 'existing comment',
      createdAt: 123,
    })
  })
})
