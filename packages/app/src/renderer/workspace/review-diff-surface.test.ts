// UX-28 item 4's diff-surface configuration: long lines wrap and the gutter shows source
// numbers.
//
// A hidden acceptance window gives Monaco no viewport, so neither can be judged from the
// rendered DOM there (measured: one gutter number, no `.view-line` for a long line). The
// decisions themselves live in code, so they are asserted here, and the numbering has its
// behavioural tests in `review-diff-model.test.ts`.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('review diff surface configuration', () => {
  it('wraps long lines in both diff columns', async () => {
    const diff = await readFile(new URL('./review-diff.tsx', import.meta.url), 'utf8')
    expect(diff).toContain("diffWordWrap: 'on'")
  })

  it('feeds the editor the source line numbers from the model', async () => {
    const diff = await readFile(new URL('./review-diff.tsx', import.meta.url), 'utf8')
    // The gutter is updated from the model's mapping, not from a 1..n counter.
    expect(diff).toContain('updateReviewLineNumbers')
    expect(diff).toContain('lineNumbers: model.originalLineNumber')
    expect(diff).toContain('lineNumbers: model.modifiedLineNumber')
  })

  it('keeps the model responsible for those numbers', async () => {
    const model = await readFile(new URL('./review-diff-model.ts', import.meta.url), 'utf8')
    expect(model).toContain('originalLineNumber')
    expect(model).toContain('modifiedLineNumber')
  })
})
