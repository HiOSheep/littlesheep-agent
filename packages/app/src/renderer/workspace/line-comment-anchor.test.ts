// UX-28 item 4: a comment must not silently point at different code after a refresh, and a
// deleted file's open action has to give a sensible answer instead of a dead promise.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { lineCommentAnchorState } from './line-comment-model'

describe('line comment anchoring', () => {
  it('stays anchored while the code under the comment is unchanged', () => {
    const comment = { startLine: 2, endLine: 3, anchorText: 'const a = 1\nconst b = 2' }
    expect(lineCommentAnchorState(comment, ['import x', 'const a = 1', 'const b = 2', 'const c = 3']))
      .toBe('anchored')
  })

  it('reports a moved anchor when a refresh put different code there', () => {
    const comment = { startLine: 2, endLine: 2, anchorText: 'const a = 1' }
    expect(lineCommentAnchorState(comment, ['import x', 'const renamed = 1', 'const c = 3'])).toBe('moved')
  })

  it('says moved when the commented lines are gone entirely', () => {
    const comment = { startLine: 9, endLine: 10, anchorText: 'gone()' }
    expect(lineCommentAnchorState(comment, ['only one line'])).toBe('moved')
  })

  it('never claims either way without an anchor or readable lines', () => {
    expect(lineCommentAnchorState({ startLine: 1, endLine: 1 }, ['anything'])).toBe('unknown')
    expect(lineCommentAnchorState({ startLine: 1, endLine: 1, anchorText: 'x' }, null)).toBe('unknown')
    expect(lineCommentAnchorState({ startLine: 1, endLine: 1, anchorText: 'x' }, [])).toBe('unknown')
  })

  it('captures the anchor when a comment is created and shows the state on the card', async () => {
    const draftSource = await readFile(new URL('./line-comments.tsx', import.meta.url), 'utf8')
    const surface = await readFile(new URL('./line-comment-surface.tsx', import.meta.url), 'utf8')
    expect(draftSource).toContain('anchorText: sourceLinesForRange(sourceRange)')
    expect(draftSource).toContain('anchorState={anchorStateFor(zone.comment)}')
    expect(surface).toContain("anchorState === 'moved'")
    expect(surface).toContain('代码行已变化')
  })
})

describe('deleted file open action', () => {
  it('explains why it is unavailable instead of promising to open it', async () => {
    const source = await readFile(new URL('./review-diff.tsx', import.meta.url), 'utf8')
    expect(source).toContain("file?.status === 'deleted' ? '文件已删除，无法在文件工作台中打开'")
    expect(source).toContain('disabled={file.status === \'deleted\'}')
    expect(source).toContain('aria-label={openLabel}')
  })
})
