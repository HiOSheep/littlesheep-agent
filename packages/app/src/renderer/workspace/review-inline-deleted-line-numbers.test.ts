import { describe, expect, it } from 'vitest'
import {
  collectInlineDeletedLineNumberGroups,
  resolveDeletedLineViewRowStarts,
} from './review-inline-deleted-line-numbers'

describe('workspace review inline deleted line numbers', () => {
  it('maps inline deletion ranges back to their original source line numbers', () => {
    const lines = ['unchanged', 'old replacement', 'between', 'old one', 'old two']
    const groups = collectInlineDeletedLineNumberGroups([
      { originalStartLineNumber: 1, originalEndLineNumber: 0 },
      { originalStartLineNumber: 2, originalEndLineNumber: 2 },
      { originalStartLineNumber: 4, originalEndLineNumber: 5 },
    ], {
      getLineCount: () => lines.length,
      getLineContent: (lineNumber) => lines[lineNumber - 1] ?? '',
    }, (lineNumber) => ['19', '20', '21', '47', '48'][lineNumber - 1] ?? '')

    expect(groups).toEqual([
      {
        originalModelLineNumbers: [2],
        sourceLineNumbers: ['20'],
        sourceLines: ['old replacement'],
      },
      {
        originalModelLineNumbers: [4, 5],
        sourceLineNumbers: ['47', '48'],
        sourceLines: ['old one', 'old two'],
      },
    ])
  })

  it('places each number on the first visual row of a wrapped deleted line', () => {
    expect(resolveDeletedLineViewRowStarts(
      [
        "it('fails closed after an escape sequence', () => {",
        '\treturn oldValue',
      ],
      [
        "it('fails closed after an ",
        "escape sequence', () => {",
        '    return ',
        'oldValue',
      ],
    )).toEqual([0, 2])
  })
})
