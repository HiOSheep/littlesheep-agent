import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'

describe('workspace Markdown preview modes', () => {
  it('renders ordinary Markdown by default and mounts Monaco only for source mode', async () => {
    const previewPane = await source('./preview-pane.tsx')

    expect(previewPane).toContain("import { Markdown } from '../Markdown'")
    expect(previewPane).toContain("const isMarkdown = preview?.kind === 'markdown'")
    expect(previewPane).toContain('const [showMarkdownSource, setShowMarkdownSource] = useState(false)')
    expect(previewPane).toContain('const editorVisible = editable && (!isMarkdown || showMarkdownSource)')
    expect(previewPane).toContain('isMarkdown && !showMarkdownSource && (')
    expect(previewPane).toContain('<Markdown text={editorText} />')
    expect(previewPane).toContain('!loading && !error && editorVisible && (')
  })

  it('puts the source toggle before edit and preserves the source/edit transition contract', async () => {
    const previewPane = await source('./preview-pane.tsx')
    const previewActions = await source('./preview-actions.tsx')
    const sourceToggle = previewActions.indexOf("{showMarkdownSource ? '查看预览' : '查看源代码'}")
    const editToggle = previewActions.indexOf("{editing ? '只读' : '编辑'}")

    expect(sourceToggle).toBeGreaterThanOrEqual(0)
    expect(editToggle).toBeGreaterThan(sourceToggle)
    expect(previewPane).toContain('<WorkspacePreviewActions')
    expect(previewPane).toContain('if (isMarkdown && !showMarkdownSource) setShowMarkdownSource(true)')
    expect(previewPane).toContain('if (!nextSourceVisible && editing) updateEditing(false)')
    expect(previewPane).toContain('setShowMarkdownSource(isMarkdown && nextEditing)')
  })

  it('keeps Markdown files in source Diff mode during Git review', async () => {
    const reviewDiff = await source('./review-diff.tsx')

    expect(workspaceLanguageForPath('README.md')).toBe('markdown')
    expect(reviewDiff).toContain('const modifiedLanguage = workspaceLanguageForPath(file.path)')
    expect(reviewDiff).toContain('<WorkspaceCodeDiffEditor')
    expect(reviewDiff).not.toContain("from '../Markdown'")
    expect(reviewDiff).not.toContain('<Markdown ')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
