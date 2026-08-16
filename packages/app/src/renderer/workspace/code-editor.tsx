// Shared Monaco loader, theme, and editor defaults for workspace code surfaces.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffEditorProps, EditorProps } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import {
  configureLittleSheepMonaco,
  prepareLittleSheepMonacoLanguages,
} from './monaco-language-support'
import { workspaceMonacoModelRegistry } from './monaco-model-cache'
import { LITTLE_SHEEP_MONACO_THEME } from './monaco-theme'

export const WORKSPACE_MONACO_FONT_FAMILY =
  'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'

// Keep the editor gutter stable across ordinary files and Git review. A
// four-character line-number reserve plus a dedicated decoration gutter keeps
// line-comment controls between the number and code without covering either.
export const WORKSPACE_MONACO_LINE_NUMBERS_MIN_CHARS = 4
export const WORKSPACE_MONACO_LINE_DECORATIONS_WIDTH = 28

export function workspaceEditorModelPath(root: string, path: string, scopeKey = 'shared'): string {
  const safeScopeKey = encodeURIComponent(scopeKey)
  const safeRoot = root.split(/[\\/]+/u).map(encodeURIComponent).join('/')
  const safePath = path.split(/[\\/]+/u).map(encodeURIComponent).join('/')
  return `inmemory://littlesheep-file/${safeScopeKey}/${safeRoot}/${safePath}`
}

export const WORKSPACE_MONACO_BASE_OPTIONS = {
  automaticLayout: true,
  fontFamily: WORKSPACE_MONACO_FONT_FAMILY,
  fontSize: 13,
  fontWeight: '500',
  lineHeight: 23,
  lineDecorationsWidth: WORKSPACE_MONACO_LINE_DECORATIONS_WIDTH,
  lineNumbersMinChars: WORKSPACE_MONACO_LINE_NUMBERS_MIN_CHARS,
  minimap: { enabled: false },
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  padding: { top: 12, bottom: 12 },
  renderLineHighlight: 'none',
  scrollBeyondLastLine: false,
  scrollbar: {
    horizontalScrollbarSize: 10,
    useShadows: false,
    verticalScrollbarSize: 10,
  },
  smoothScrolling: true,
  wordWrap: 'on',
} satisfies Monaco.editor.IStandaloneEditorConstructionOptions

type WorkspaceCodeEditorProps = Omit<
  EditorProps,
  'beforeMount' | 'keepCurrentModel' | 'loading' | 'options' | 'saveViewState' | 'theme'
> & {
  loading?: ReactNode
  options?: EditorProps['options']
}

type WorkspaceCodeDiffEditorProps = Omit<
  DiffEditorProps,
  | 'beforeMount'
  | 'keepCurrentModifiedModel'
  | 'keepCurrentOriginalModel'
  | 'loading'
  | 'options'
  | 'theme'
> & {
  loading?: ReactNode
  options?: DiffEditorProps['options']
}

export function WorkspaceCodeEditor({
  loading = null,
  onMount,
  options,
  path,
  ...props
}: WorkspaceCodeEditorProps) {
  const lifecycleRef = useRef<EditorModelLifecycle | null>(null)
  const languageReady = usePreparedWorkspaceMonacoLanguages([props.language ?? 'plaintext'])
  const mergedOptions = useMemo(
    () => ({ ...WORKSPACE_MONACO_BASE_OPTIONS, ...options }),
    [options],
  )
  useLayoutEffect(() => {
    const lifecycle = lifecycleRef.current
    if (lifecycle && path && lifecycle.modelUri() !== path) lifecycle.saveViewState()
  }, [path])
  useEffect(() => () => {
    lifecycleRef.current?.dispose()
    lifecycleRef.current = null
  }, [])
  if (!languageReady) return <>{loading}</>
  return (
    <Suspense fallback={loading}>
      <MonacoEditor
        {...props}
        path={path}
        loading={loading}
        theme={LITTLE_SHEEP_MONACO_THEME}
        beforeMount={configureLittleSheepMonaco}
        keepCurrentModel
        saveViewState={false}
        onMount={(editor, monaco) => {
          lifecycleRef.current?.dispose()
          lifecycleRef.current = trackCodeEditorModel(editor, true)
          onMount?.(editor, monaco)
        }}
        options={mergedOptions}
      />
    </Suspense>
  )
}

export function WorkspaceCodeDiffEditor({
  loading = null,
  modifiedLanguage,
  onMount,
  options,
  originalLanguage,
  ...props
}: WorkspaceCodeDiffEditorProps) {
  const lifecycleRef = useRef<EditorModelLifecycle | null>(null)
  const languageReady = usePreparedWorkspaceMonacoLanguages([
    originalLanguage ?? 'plaintext',
    modifiedLanguage ?? 'plaintext',
  ])
  const mergedOptions = useMemo(
    () => ({ ...WORKSPACE_MONACO_BASE_OPTIONS, ...options }),
    [options],
  )
  useEffect(() => () => {
    lifecycleRef.current?.dispose()
    lifecycleRef.current = null
  }, [])
  if (!languageReady) return <>{loading}</>
  return (
    <Suspense fallback={loading}>
      <MonacoDiffEditor
        {...props}
        originalLanguage={originalLanguage}
        modifiedLanguage={modifiedLanguage}
        loading={loading}
        theme={LITTLE_SHEEP_MONACO_THEME}
        beforeMount={configureLittleSheepMonaco}
        keepCurrentModifiedModel
        keepCurrentOriginalModel
        onMount={(editor, monaco) => {
          lifecycleRef.current?.dispose()
          const original = trackCodeEditorModel(editor.getOriginalEditor(), false)
          const modified = trackCodeEditorModel(editor.getModifiedEditor(), false)
          lifecycleRef.current = {
            dispose: () => {
              original.dispose()
              modified.dispose()
            },
            modelUri: () => modified.modelUri(),
            saveViewState: () => undefined,
          }
          onMount?.(editor, monaco)
        }}
        options={mergedOptions}
      />
    </Suspense>
  )
}

type MonacoReactModule = typeof import('@monaco-editor/react')

let monacoReactPromise: Promise<MonacoReactModule> | null = null
let monacoCorePromise: Promise<typeof Monaco> | null = null
let monacoReactLoaded = false
const preparedLanguages = new Set<string>()

function loadMonacoCore(): Promise<typeof Monaco> {
  monacoCorePromise ??= import('monaco-editor/esm/vs/editor/editor.api.js')
  return monacoCorePromise
}

function loadMonacoReact(): Promise<MonacoReactModule> {
  monacoReactPromise ??= Promise.all([
    import('@monaco-editor/react'),
    loadMonacoCore(),
  ]).then(([monacoReact, monaco]) => {
    monacoReact.loader.config({ monaco })
    monacoReactLoaded = true
    return monacoReact
  })
  return monacoReactPromise
}

export async function preloadWorkspaceCodeEditor(...languageIds: string[]): Promise<void> {
  await loadMonacoReact()
  const monaco = await loadMonacoCore()
  const normalized = normalizeLanguageIds(languageIds)
  await prepareLittleSheepMonacoLanguages(monaco, normalized)
  for (const languageId of normalized) preparedLanguages.add(languageId)
}

function usePreparedWorkspaceMonacoLanguages(languageIds: string[]): boolean {
  const normalized = normalizeLanguageIds(languageIds)
  const key = normalized.join('\u0000')
  const [, setCompletedVersion] = useState(0)
  const ready = monacoReactLoaded && normalized.every((languageId) => preparedLanguages.has(languageId))
  useEffect(() => {
    if (ready) return
    let alive = true
    void preloadWorkspaceCodeEditor(...normalized).then(() => {
      if (alive) setCompletedVersion((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [key, ready])
  return ready
}

function normalizeLanguageIds(languageIds: readonly string[]): string[] {
  return [...new Set(languageIds.map((languageId) => languageId.trim() || 'plaintext'))].sort()
}

interface EditorModelLifecycle {
  dispose: () => void
  modelUri: () => string
  saveViewState: () => void
}

function trackCodeEditorModel(
  editor: Monaco.editor.IStandaloneCodeEditor,
  preserveViewState: boolean,
): EditorModelLifecycle {
  let model = editor.getModel()
  let release = workspaceMonacoModelRegistry.acquire(model)
  const modelUri = () => model?.uri.toString() ?? ''
  const restoreViewState = () => {
    if (!preserveViewState || !model) return
    const state = workspaceMonacoModelRegistry.readViewState<Monaco.editor.ICodeEditorViewState>(modelUri())
    if (state) editor.restoreViewState(state)
  }
  const saveViewState = () => {
    if (!preserveViewState || !model) return
    const state = editor.saveViewState()
    if (state) workspaceMonacoModelRegistry.saveViewState(modelUri(), state)
  }
  restoreViewState()
  const subscription = editor.onDidChangeModel(() => {
    release()
    model = editor.getModel()
    release = workspaceMonacoModelRegistry.acquire(model)
    restoreViewState()
  })
  return {
    dispose: () => {
      saveViewState()
      subscription.dispose()
      release()
    },
    modelUri,
    saveViewState,
  }
}

const MonacoEditor = lazy(async () => ({ default: (await loadMonacoReact()).default }))
const MonacoDiffEditor = lazy(async () => ({ default: (await loadMonacoReact()).DiffEditor }))
