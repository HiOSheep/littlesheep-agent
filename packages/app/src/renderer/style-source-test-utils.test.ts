import { describe, expect, it } from 'vitest'
import {
  readRendererStyleSource,
  readRendererStyleSourceFiles,
  RENDERER_STYLE_SOURCE_PATHS,
} from './style-source-test-utils'

describe('renderer style source manifest', () => {
  it('loads every non-empty domain exactly once in cascade order', async () => {
    const files = await readRendererStyleSourceFiles()

    expect(files.map(({ path }) => path)).toEqual(RENDERER_STYLE_SOURCE_PATHS)
    expect(new Set(files.map(({ path }) => path)).size).toBe(files.length)
    expect(files.every(({ source }) => source.length > 0)).toBe(true)
  })

  it('reconstructs one complete source for existing CSS contract tests', async () => {
    const source = await readRendererStyleSource()

    expect(source).toContain(':root {')
    expect(source).toContain('.workspace-panel-resizer {')
    expect(source).toContain('.messages {')
    expect(source).toContain('.composer-shell {')
    expect(source).toContain('.workspace-review-monaco-diff')
  })
})
