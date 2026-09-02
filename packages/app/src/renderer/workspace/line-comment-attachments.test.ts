import { describe, expect, it } from 'vitest'
import {
  lineCommentScopeMatchesAttachment,
  mergeLineCommentAttachment,
  updateLineCommentAttachment,
} from './line-comment-attachments'

describe('line comment attachments', () => {
  it('merges comments for the same file without losing ordinary attachment metadata', () => {
    const merged = mergeLineCommentAttachment([{
      path: 'D:\\work\\src\\app.ts',
      name: 'app.ts',
      kind: 'file',
      size: 128,
      lineComments: [{ startLine: 8, text: 'Handle the empty case.' }],
    }], {
      path: 'd:/work/src/app.ts',
      name: 'app.ts',
      kind: 'file',
      lineComments: [{ startLine: 21, endLine: 23, text: 'Keep this range atomic.' }],
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ size: 128 })
    expect(merged[0]?.lineComments).toEqual([
      { startLine: 8, text: 'Handle the empty case.' },
      { startLine: 21, endLine: 23, text: 'Keep this range atomic.' },
    ])
  })

  it('deduplicates an identical published comment', () => {
    const attachment = {
      path: 'D:\\work\\src\\app.ts',
      lineComments: [{ startLine: 8, text: 'Handle the empty case.' }],
    }

    expect(mergeLineCommentAttachment([attachment], attachment)[0]?.lineComments).toHaveLength(1)
  })

  it('replaces an edited comment when the published attachment keeps its id', () => {
    const merged = mergeLineCommentAttachment([{
      path: 'D:\\work\\src\\app.ts',
      lineComments: [
        { id: 'comment-a', startLine: 8, text: 'old text' },
        { id: 'comment-b', startLine: 21, text: 'keep this' },
      ],
    }], {
      path: 'D:\\work\\src\\app.ts',
      lineComments: [{ id: 'comment-a', startLine: 8, text: 'new text' }],
    })

    expect(merged[0]?.lineComments).toEqual([
      { id: 'comment-a', startLine: 8, text: 'new text' },
      { id: 'comment-b', startLine: 21, text: 'keep this' },
    ])
  })

  it('retains distinct review snapshots while merging comments for one file', () => {
    const merged = mergeLineCommentAttachment([{
      path: 'D:\\work\\src\\app.ts',
      inlineText: 'modified snapshot',
      lineComments: [{ startLine: 8, text: 'modified comment' }],
    }], {
      path: 'D:\\work\\src\\app.ts',
      inlineText: 'original snapshot',
      lineComments: [{ startLine: 9, text: 'original comment' }],
    })

    expect(merged[0]?.inlineText).toBe('modified snapshot\n\noriginal snapshot')
    expect(merged[0]?.lineComments).toHaveLength(2)
  })

  it('matches ordinary file scopes through the attachment path', () => {
    expect(lineCommentScopeMatchesAttachment(
      'D:\\repo\u0000file\u0000D:\\repo\\src\\app.ts',
      { path: 'd:/repo/src/app.ts' },
    )).toBe(true)
    expect(lineCommentScopeMatchesAttachment(
      'D:\\repo\u0000file\u0000D:\\repo\\src\\other.ts',
      { path: 'd:/repo/src/app.ts' },
    )).toBe(false)
  })

  it('matches review scopes through the source context path', () => {
    expect(lineCommentScopeMatchesAttachment(
      'D:\\repo\u0000review\u0000src\\old-app.ts\u0000unstaged\u0000original',
      { path: 'D:\\repo\\src\\app.ts', contextPath: 'src/old-app.ts' },
    )).toBe(true)
    expect(lineCommentScopeMatchesAttachment(
      'D:\\repo\u0000review\u0000src\\unrelated.ts\u0000unstaged\u0000original',
      { path: 'D:\\repo\\src\\app.ts', contextPath: 'src/old-app.ts' },
    )).toBe(false)
  })

  it('updates one published comment without changing its sibling comments', () => {
    const attachments = [{
      path: 'D:\\work\\src\\app.ts',
      lineCommentOnly: true,
      lineComments: [
        { id: 'comment-a', startLine: 8, text: 'old text' },
        { id: 'comment-b', startLine: 21, text: 'keep this' },
      ],
    }]

    const updated = updateLineCommentAttachment(attachments, {
      attachment: attachments[0]!,
      previous: { id: 'comment-a', startLine: 8, text: 'old text' },
      next: { id: 'comment-a', startLine: 8, text: 'new text' },
    })

    expect(updated[0]?.lineComments).toEqual([
      { id: 'comment-a', startLine: 8, text: 'new text' },
      { id: 'comment-b', startLine: 21, text: 'keep this' },
    ])
  })

  it('removes only one published comment and removes a comment-only attachment when empty', () => {
    const attachment = {
      path: 'D:\\work\\src\\app.ts',
      lineCommentOnly: true,
      lineComments: [
        { id: 'comment-a', startLine: 8, text: 'remove this' },
        { id: 'comment-b', startLine: 21, text: 'keep this' },
      ],
    }
    const remaining = updateLineCommentAttachment([attachment], {
      attachment,
      previous: { id: 'comment-a', startLine: 8, text: 'remove this' },
      next: null,
    })

    expect(remaining[0]?.lineComments).toEqual([
      { id: 'comment-b', startLine: 21, text: 'keep this' },
    ])

    expect(updateLineCommentAttachment(remaining, {
      attachment: remaining[0]!,
      previous: { id: 'comment-b', startLine: 21, text: 'keep this' },
      next: null,
    })).toEqual([])
  })

  it('matches legacy review comment text with its appended review context', () => {
    const attachment = {
      path: 'D:\\work\\src\\app.ts',
      contextPath: 'src/app.ts',
      lineComments: [{ startLine: 8, text: 'remove this\n\nGit 审阅上下文：未暂存 / 修改后 / src/app.ts' }],
    }

    expect(updateLineCommentAttachment([attachment], {
      attachment,
      previous: { startLine: 8, text: 'remove this' },
      next: null,
    })).toEqual([{ ...attachment, lineComments: undefined }])
  })
})
