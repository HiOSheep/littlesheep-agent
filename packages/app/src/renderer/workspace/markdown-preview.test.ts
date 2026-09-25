import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'

describe('workspace Markdown preview modes', () => {
  it('renders ordinary Markdown by default and mounts Monaco only for source mode', async () => {
    const previewPane = await source('./preview-pane.tsx')
    const previewActions = await source('./preview-actions.tsx')

    expect(previewPane).toContain("import { Markdown } from '../Markdown'")
    expect(previewPane).toContain("const isMarkdown = preview?.kind === 'markdown'")
    expect(previewPane).toContain("const isHtml = preview?.kind === 'html'")
    expect(previewPane).toMatch(
      /const \[showMarkdownSource, setShowMarkdownSource\] = useState\(\s*isMarkdown && initialEditorState\.editing,\s*\)/u,
    )
    expect(previewPane).toContain('const editorVisible = editable && (!isMarkdown || showMarkdownSource)')
    expect(previewPane).toContain('isMarkdown && !showMarkdownSource && (')
    expect(previewPane).toContain('const [showHtmlSource, setShowHtmlSource] = useState(')
    expect(previewPane).toContain('isHtml && !showHtmlSource && (')
    // UX-25 item 2: the static HTML preview is handed the served asset base so its
    // relative styles/images/fonts can load through Main's bounded loopback service.
    expect(previewPane).toContain('<WorkspaceHtmlPreview')
    expect(previewPane).toContain('<WorkspaceHtmlPreviewSurface')
    expect(previewPane).toContain('root={workspacePath}')
    expect(previewPane).toContain('<Markdown text={editorText} />')
    expect(previewPane).toContain("wordWrap: codeWrapEnabled ? 'on' : 'off'")
    expect(previewActions).toContain('<CodeWrapToggle')
    expect(previewActions).toContain('{showCodeWrapToggle && (')
    expect(previewPane).toContain('!loading && !error && editorVisible && (')
  })

  it('renders Mermaid fenced diagrams as visual, safe SVG blocks with a code fallback', async () => {
    const markdown = await source('../Markdown.tsx')
    const styles = await readRendererStyleSource()

    expect(markdown).toContain("const MERMAID_LANGUAGE_ALIASES = new Set([")
    expect(markdown).toContain("'statediagram-v2'")
    expect(markdown).toContain('const MERMAID_DEFINITION_PATTERN =')
    expect(markdown).toContain("/language-([\\w-]+)/u")
    expect(markdown).toContain('if (isMermaidCodeBlock(language, code))')
    expect(markdown).toContain('<MermaidBlock code={code} />')
    expect(markdown).toContain("securityLevel: 'strict'")
    expect(markdown).toContain("theme: 'base'")
    expect(markdown).toContain('dangerouslySetInnerHTML={{ __html: svg }}')
    expect(markdown).toContain('if (renderFailed || !svg) return <CodeBlock code={code} language="text" />')
    expect(styles).toMatch(/\.mermaid-block-surface\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*auto;[^}]*padding:\s*34px 18px 18px;/u)
    expect(styles).toMatch(/\.mermaid-block\s*\{[^}]*overflow:\s*visible;[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/u)
    expect(styles).toMatch(/\.mermaid-block\s*> \.code-toolbar\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity\s+var\(--motion-fast\)\s+var\(--motion-ease\);/u)
    expect(styles).toMatch(/\.mermaid-block:hover\s*> \.code-toolbar,\s*\.mermaid-block:focus-within\s*> \.code-toolbar\s*\{[^}]*opacity:\s*1;/u)
    expect(styles).toMatch(/\.mermaid-block-surface > svg\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*min\(680px, 100%\);[^}]*height:\s*auto;/u)
    expect(styles).toMatch(/\.mermaid-block-surface > svg \.stateGroup rect[\s\S]*?rx:\s*7px;[\s\S]*?ry:\s*7px;/u)
  })

  it('puts the source toggle before edit and preserves the source/edit transition contract', async () => {
    const previewPane = await source('./preview-pane.tsx')
    const previewActions = await source('./preview-actions.tsx')
    const sourceToggle = previewActions.indexOf("{showMarkdownSource ? '查看预览' : '查看源代码'}")
    const editToggle = previewActions.indexOf("{editing ? '只读' : '编辑'}")

    expect(sourceToggle).toBeGreaterThanOrEqual(0)
    expect(editToggle).toBeGreaterThan(sourceToggle)
    expect(previewActions).not.toContain('保存')
    expect(previewActions).not.toContain('onSave')
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
      const markdownLinkRule = styles.match(/\.markdown a\s*\{([^}]*)\}/u)?.[1] ?? ''
      const inlineCodeRule = styles.match(/\.markdown-inline-code\s*\{([^}]*)\}/u)?.[1] ?? ''
    const blockRule = styles.match(/\.code-block\s*\{([^}]*)\}/u)?.[1] ?? ''
    const toolbarRule = styles.match(/\.code-toolbar\s*\{([^}]*)\}/u)?.[1] ?? ''
    const blockCodeRule = styles.match(/\.code-block code\s*\{([^}]*)\}/u)?.[1] ?? ''
    const sourceCodeRule = styles.match(/\.code-block-source > code\s*\{([^}]*)\}/u)?.[1] ?? ''
    const tokenRule = [...styles.matchAll(/\.code-block-source \.token\s*\{([^}]*)\}/gu)].pop()?.[1] ?? ''

    expect(previewPane).toContain('<Markdown text={editorText} />')
    expect(assistantTurn).toContain('<Markdown text={message.text}')
    expect(markdown).toContain('className="markdown-inline-code"')
    expect(markdown).toContain('className="markdown-table-wrap"')
    expect(markdown).toContain('<table>{children}</table>')
    expect(markdown).toContain("if (!language && !rawCode.endsWith('\\n'))")
    expect(markdown).toContain("return <CodeBlock code={code} language={language ?? 'text'} />")
    expect(markdown).toContain('import { CheckIcon, CopyIcon } from \'./ui/icons\'')
    expect(markdown).toContain('function CodeToolbar(')
    expect(markdown).toContain('<CodeToolbar code={code} language={language} wrapped={wrapped} onToggleWrap={onToggleWrap} />')
    expect(markdown).toContain('className="code-block-source"')
    expect(markdown).toContain('wrapLongLines={wrapped}')
    expect(markdown).toContain('data-code-wrap={wrapped ? \'on\' : \'off\'}')
    expect(markdown).not.toContain('<span>{language}</span>')
      expect(markdown).toContain('function CopyButton({ text, label }: { text: string; label: string })')
      expect(markdown).toContain('aria-label={copied ? `${label}已复制` : `复制${label}`}')
      expect(markdownLinkRule).toContain('color: #5da1f7;')
      expect(markdownLinkRule).toContain('border-bottom: 1px solid rgba(93, 161, 247, 0.32);')
    expect(inlineCodeRule).toContain('background: var(--control)')
    expect(inlineCodeRule).toContain('border: 0')
    expect(inlineCodeRule).toContain('box-shadow: none')
    expect(blockRule).toContain('background: #202020')
    expect(blockRule).toContain('border: 0')
    expect(blockRule).toContain('box-shadow: none')
    expect(blockRule).toContain('--code-block-inset: 6px')
    expect(blockRule).toContain('--code-copy-button-size: 26px')
    expect(blockRule).toContain('--code-copy-safe-gap: 6px')
    expect(blockRule).toContain('position: relative')
    expect(toolbarRule).toContain('background: var(--surface-2)')
    expect(toolbarRule).toContain('border-bottom: 1px solid var(--border)')
    expect(toolbarRule).toContain('justify-content: space-between')
    expect(toolbarRule).toContain('min-height: 30px')
    expect(styles).toMatch(/\.mermaid-block > \.code-toolbar\s*\{[^}]*position:\s*absolute;[^}]*background:\s*transparent;/u)
    expect(blockCodeRule).toContain('background: transparent')
    expect(blockCodeRule).toContain('border: 0')
    expect(blockCodeRule).toContain('box-shadow: none')
    expect(sourceCodeRule).toContain('color: var(--text) !important')
    expect(styles).toMatch(/\.code-block-source\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?white-space:\s*pre-wrap;/u)
    expect(tokenRule).toContain('color: var(--text) !important')
    expect(styles).toMatch(/\.code-block-source\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?white-space:\s*pre-wrap;/u)
    expect(styles).toMatch(/\.code-block-source > code,[\s\S]*?\.code-block-source \.token\s*\{[\s\S]*?background:\s*transparent !important;/u)
    expect(styles).toMatch(/\.code-block-source\[data-code-wrap="off"\]\s*\{[^}]*overflow-x:\s*auto;[^}]*white-space:\s*pre;/u)
    expect(styles).toMatch(/\.code-block-source\[data-code-wrap="on"\]\s*\{[^}]*white-space:\s*pre-wrap;/u)
    expect(styles).toMatch(/\.code-toolbar button\s*\{[\s\S]*?width:\s*var\(--code-copy-button-size\);[\s\S]*?height:\s*var\(--code-copy-button-size\);[\s\S]*?padding:\s*0;[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*var\(--radius-circle\);/u)
    expect(styles).toMatch(/\.code-toolbar button:hover,[\s\S]*?\.code-toolbar button:focus-visible\s*\{[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.14\);[\s\S]*?border-color:\s*transparent;/u)
  })

  it('uses larger, level-specific heading spacing in Markdown preview', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown h1\s*\{[^}]*margin-top:\s*38px;[^}]*margin-bottom:\s*24px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown h2\s*\{[^}]*margin-top:\s*34px;[^}]*margin-bottom:\s*21px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown h3\s*\{[^}]*margin-top:\s*29px;[^}]*margin-bottom:\s*18px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown h4\s*\{[^}]*margin-top:\s*24px;[^}]*margin-bottom:\s*15px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown > :first-child:is\(h1, h2, h3, h4\)\s*\{[^}]*margin-top:\s*4px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown > p,[\s\S]*?\.workspace-preview-markdown \.markdown > \.markdown-table-wrap\s*\{[^}]*margin-bottom:\s*20px;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown > :last-child\s*\{[^}]*margin-bottom:\s*0;/u)
    expect(styles).toMatch(/\.workspace-preview-markdown \.markdown hr\s*\{[^}]*margin:\s*28px 0;/u)
  })

  it('makes Markdown tables fill the available row and clip to rounded corners', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.markdown-table-wrap\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.markdown-table-wrap table\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*100%;[^}]*border-collapse:\s*separate;[^}]*border-spacing:\s*0;/u)
    expect(styles).toMatch(/\.markdown tr > :last-child\s*\{[^}]*border-right:\s*0;/u)
    expect(styles).toMatch(/\.markdown tbody tr:last-child > \*\s*\{[^}]*border-bottom:\s*0;/u)
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
