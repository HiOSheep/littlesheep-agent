import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'

describe('workspace Markdown preview modes', () => {
  it('renders ordinary Markdown by default and mounts Monaco only for source mode', async () => {
    const previewPane = await source('./preview-pane.tsx')

    expect(previewPane).toContain("import { Markdown } from '../Markdown'")
    expect(previewPane).toContain("const isMarkdown = preview?.kind === 'markdown'")
    expect(previewPane).toMatch(
      /const \[showMarkdownSource, setShowMarkdownSource\] = useState\(\s*isMarkdown && initialEditorState\.editing,\s*\)/u,
    )
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

  it('shares one opaque borderless gray code surface with conversation Markdown', async () => {
    const previewPane = await source('./preview-pane.tsx')
    const assistantTurn = await source('../chat/assistant-turn.tsx')
    const styles = await readRendererStyleSource()
    const markdown = await source('../Markdown.tsx')
    const inlineCodeRule = styles.match(/\.markdown-inline-code\s*\{([^}]*)\}/u)?.[1] ?? ''
    const blockRule = styles.match(/\.code-block\s*\{([^}]*)\}/u)?.[1] ?? ''
    const toolbarRule = styles.match(/\.code-toolbar\s*\{([^}]*)\}/u)?.[1] ?? ''
    const blockCodeRule = styles.match(/\.code-block code\s*\{([^}]*)\}/u)?.[1] ?? ''

    expect(previewPane).toContain('<Markdown text={editorText} />')
    expect(assistantTurn).toContain('<Markdown text={message.text}')
    expect(markdown).toContain('className="markdown-inline-code"')
    expect(markdown).toContain("if (!language && !rawCode.endsWith('\\n'))")
    expect(markdown).toContain("return <CodeBlock code={code} language={language ?? 'text'} />")
    expect(inlineCodeRule).toContain('background: var(--control)')
    expect(inlineCodeRule).toContain('border: 0')
    expect(inlineCodeRule).toContain('box-shadow: none')
    expect(blockRule).toContain('background: var(--control)')
    expect(blockRule).toContain('border: 0')
    expect(blockRule).toContain('box-shadow: none')
    expect(toolbarRule).toContain('background: transparent')
    expect(toolbarRule).toContain('border-bottom: 0')
    expect(blockCodeRule).toContain('background: transparent')
    expect(blockCodeRule).toContain('border: 0')
    expect(blockCodeRule).toContain('box-shadow: none')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
