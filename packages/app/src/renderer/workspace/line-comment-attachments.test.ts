import { describe, expect, it } from 'vitest'
import { mergeLineCommentAttachment } from './line-comment-attachments'

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
})
