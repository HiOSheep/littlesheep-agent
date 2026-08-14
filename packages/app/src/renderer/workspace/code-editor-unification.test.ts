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
  })

  it('uses one relaxed code-density contract for file and review editors', async () => {
    const primitive = await source('./code-editor.tsx')
    const review = await source('./review-diff.tsx')

    expect(primitive).toContain('fontSize: 13')
    expect(primitive).toContain('lineHeight: 23')
    expect(review).toContain('renderSideBySide: sideBySide')
    expect(review).toContain('aria-pressed={sideBySide}')
    expect(review).not.toContain('renderSideBySide: true')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
