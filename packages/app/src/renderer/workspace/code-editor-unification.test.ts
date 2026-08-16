import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MONACO_BUILTIN_LANGUAGE_IDS } from '../../shared/workspace-languages'
import { WORKSPACE_MONACO_LAZY_LANGUAGE_IDS } from './monaco-language-loaders'

describe('workspace code editor unification', () => {
  it('keeps Monaco loading, theme, and defaults in one workspace primitive', async () => {
    const primitive = await source('./code-editor.tsx')
    const preview = await source('./preview-pane.tsx')
    const review = await source('./review-diff.tsx')

    expect(primitive).toContain('export function WorkspaceCodeEditor')
    expect(primitive).toContain('export function WorkspaceCodeDiffEditor')
    expect(primitive).toMatch(/export (?:async )?function preloadWorkspaceCodeEditor/u)
    expect(primitive).toContain('function loadMonacoReact')
    expect(primitive).toContain("monaco-editor/esm/vs/editor/editor.api.js")
    expect(primitive).not.toContain("import('monaco-editor')")
    expect(primitive).toContain('workspaceEditorModelPath')
    expect(primitive.match(/loader\.config/gu)).toHaveLength(1)
    expect(preview).toContain('<WorkspaceCodeEditor')
    expect(review).toContain('<WorkspaceCodeDiffEditor')
    expect(preview).not.toContain("import('@monaco-editor/react')")
    expect(review).not.toContain("import('@monaco-editor/react')")
  })

  it('loads every declared built-in tokenizer without language-service workers', async () => {
    expect(new Set(WORKSPACE_MONACO_LAZY_LANGUAGE_IDS)).toEqual(new Set(
      [...MONACO_BUILTIN_LANGUAGE_IDS].filter((languageId) => languageId !== 'json'),
    ))
    const config = await source('../../../electron.vite.config.ts')
    expect(config).toContain('isolateMonacoLanguageDefinitions')
    expect(config).toContain('isolate-monaco-language-definitions')
    expect(config).toContain('monacoLanguageContributionImport')
    expect(config).toContain('rejectMonacoLanguageWorkers')
    expect(config).toContain('Monaco language workers are outside the LS workspace contract')
    expect(config).toContain('ISuggestMemories|actionWidgetService')
    expect(config).toContain('Monaco language definitions pulled editor contributions')
    const performanceVerifier = await source('../../../../../scripts/verify-workspace-performance.mjs')
    expect(performanceVerifier).toContain('summarizeRendererDiagnostics')
    expect(performanceVerifier).toContain('depends on UNKNOWN service')
    expect(performanceVerifier).toContain('rendererDiagnostics.unknownServiceErrors.length === 0')
  })

  it('does not retain the handwritten review code-line renderer', async () => {
    const review = await source('./review-diff.tsx')
    const styles = await source('../styles.css')

    expect(review).not.toContain('<code>')
    expect(review).not.toContain('workspace-review-diff-line')
    expect(styles).not.toContain('.workspace-review-diff-line')
    expect(styles).not.toContain('.workspace-review-line-number')
    expect(styles).not.toContain('.workspace-review-line-marker')
    expect(styles).toContain('.workspace-review-monaco-diff .monaco-editor .gutter-insert')
    expect(styles).toContain('.workspace-review-monaco-diff .monaco-editor .gutter-delete')
    expect(styles).toContain('--workspace-review-insert-line-background: rgb(35 69 39 / 50%)')
    expect(styles).toContain('--workspace-review-delete-line-background: rgb(93 41 29 / 50%)')
    expect(styles).toContain('background-color: var(--workspace-review-insert-line-background)')
    expect(styles).toContain('background-color: var(--workspace-review-delete-line-background)')
    expect(styles).toContain('.workspace-review-monaco-diff .monaco-editor .inline-deleted-margin-view-zone')
    expect(review).toContain('attachReviewInlineDeletedLineNumbers')
    expect(styles).toContain('.workspace-review-inline-deleted-line-number')
    expect(styles).toMatch(/\.char-delete,[\s\S]*?\.inline-deleted-text \{\s*background-color: transparent;\s*\}/u)
    expect(styles).toContain('background-image: linear-gradient(to right, #02a243 0 5px, transparent 5px)')
    expect(styles).toContain('background-image: linear-gradient(to right, #de352e 0 5px, transparent 5px)')
    expect(styles).toMatch(/:has\(> \.gutter-insert\) > \.line-numbers\s*\{\s*color: #02a243;\s*\}/u)
    expect(styles).toMatch(/:has\(> \.gutter-delete\) > \.line-numbers\s*\{\s*color: #de352e;\s*\}/u)
    expect(styles).toMatch(/\.workspace-review-line-counts \.additions\s*\{\s*color: #02a243;\s*\}/u)
    expect(styles).toMatch(/\.workspace-review-line-counts \.deletions\s*\{\s*color: #de352e;\s*\}/u)
    expect(styles).toMatch(/\.workspace-review-line-counts\.compact\s*\{[\s\S]*?font-size: 10px;[\s\S]*?\}/u)
    expect(styles).not.toContain('box-shadow: inset 2px 0')
  })

  it('uses one relaxed code-density contract for file and review editors', async () => {
    const primitive = await source('./code-editor.tsx')
    const preview = await source('./preview-pane.tsx')
    const review = await source('./review-diff.tsx')

    expect(primitive).toContain('fontSize: 13')
    expect(primitive).toContain('lineHeight: 23')
    expect(primitive).toContain('lineDecorationsWidth: WORKSPACE_MONACO_LINE_DECORATIONS_WIDTH')
    expect(primitive).toContain('WORKSPACE_MONACO_LINE_DECORATIONS_WIDTH = 28')
    expect(primitive).toContain('lineNumbersMinChars: WORKSPACE_MONACO_LINE_NUMBERS_MIN_CHARS')
    expect(primitive).toContain('hideCursorInOverviewRuler: true')
    expect(primitive).toContain('padding: { top: 12, bottom: 12 }')
    expect(primitive).toContain('verticalScrollbarSize: 10')
    expect(primitive.split('const mergedOptions = useMemo(').length - 1).toBe(2)
    expect(primitive.split('options={mergedOptions}').length - 1).toBe(2)
    expect(preview).toContain('const editorOptions = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>')
    expect(preview).toContain('options={editorOptions}')
    expect(review).toContain('const editorOptions = useMemo<Monaco.editor.IStandaloneDiffEditorConstructionOptions>')
    expect(review).toContain('options={editorOptions}')
    expect(review).toContain('renderSideBySide: sideBySide')
    expect(review).not.toContain("lineNumbers: 'on'")
    expect(review).toContain('updateReviewLineNumbers(diffEditorRef.current, model)')
    expect(review).toContain('getOriginalEditor().updateOptions({ lineNumbers: model.originalLineNumber })')
    expect(review).toContain('getModifiedEditor().updateOptions({ lineNumbers: model.modifiedLineNumber })')
    expect(review).toContain('renderIndicators: false')
    expect(review).toContain('aria-pressed={sideBySide}')
    expect(review).not.toContain('renderSideBySide: true')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
