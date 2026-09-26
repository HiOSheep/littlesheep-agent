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
import {
  COLUMN_RESIZE_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'

// Latin stays monospace; the CJK tail is explicit so Chinese inside the editor
// resolves to the same face as prose (Microsoft YaHei UI) instead of whatever the
// browser falls back to per glyph. Keep it in sync with `--mono`.
export const WORKSPACE_MONACO_FONT_FAMILY =
  'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", monospace'

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
  // Automatic layout recalculates Monaco's canvas on every resize-observer
  // notification. Column drags can produce one notification per frame, so the
  // shared scheduler below defers that expensive work until pointer release.
  automaticLayout: false,
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
  const monacoReady = usePreparedWorkspaceMonacoLanguages([props.language ?? 'plaintext'])
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
  if (!monacoReady) return <>{loading}</>
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
          lifecycleRef.current = trackWorkspaceEditorLifecycle(editor, true)
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
  /** The diff editor itself, so layout can be re-run when its content changes. */
  const layoutRef = useRef<WorkspaceEditorLayoutTarget | null>(null)
  const monacoReady = usePreparedWorkspaceMonacoLanguages([
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
  // The diff arrives after the editor mounts, so laying out only at mount measures an empty
  // container and Monaco keeps that size (measured: an inline `height: 5px` on its root while
  // the pane is 715 px). A resize observer would catch the growth, but it is delivered during
  // rendering — which never happens for a hidden, occluded or minimized window. Laying out
  // after each model change does not depend on that.
  useEffect(() => {
    layoutRef.current?.layout()
    const deferred = window.setTimeout(() => layoutRef.current?.layout(), 120)
    return () => window.clearTimeout(deferred)
  }, [props.original, props.modified])
  if (!monacoReady) return <>{loading}</>
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
          const stopLayoutTracking = trackWorkspaceEditorLayout(
            editor.getModifiedEditor(),
            editor,
          )
          layoutRef.current = editor
          lifecycleRef.current = {
            dispose: () => {
              stopLayoutTracking()
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

function loadMonacoCore(): Promise<typeof Monaco> {
  monacoCorePromise ??= import('monaco-editor/esm/vs/editor/editor.api.js').catch((error) => {
    monacoCorePromise = null
    throw error
  })
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
  }).catch((error) => {
    monacoReactPromise = null
    monacoReactLoaded = false
    throw error
  })
  return monacoReactPromise
}

export async function preloadWorkspaceCodeEditor(...languageIds: string[]): Promise<void> {
  await loadMonacoReact()
  const monaco = await loadMonacoCore()
  const normalized = normalizeLanguageIds(languageIds)
  try {
    await prepareLittleSheepMonacoLanguages(monaco, normalized)
  } catch (error) {
    // A language definition is optional. Keep the editor usable as plaintext
    // when a production chunk is unavailable or a definition is malformed.
    console.warn('Workspace Monaco language preparation failed; continuing without enhanced syntax support.', error)
  }
}

function usePreparedWorkspaceMonacoLanguages(languageIds: string[]): boolean {
  const normalized = normalizeLanguageIds(languageIds)
  const key = normalized.join('\u0000')
  const [monacoReady, setMonacoReady] = useState(monacoReactLoaded)
  // Loading the editor core is required for the surface to mount. Language
  // tokenizers are optional enhancements and must not keep a file preview in
  // its loading placeholder when one language chunk is unavailable.
  useEffect(() => {
    let alive = true
    void loadMonacoReact()
      .then(() => {
        if (alive) setMonacoReady(true)
      })
      .catch((error) => {
        console.warn('Workspace Monaco core failed to load.', error)
      })
    void preloadWorkspaceCodeEditor(...normalized)
      .catch((error) => {
        console.warn('Workspace Monaco language preparation failed; continuing without enhanced syntax support.', error)
      })
    return () => {
      alive = false
    }
  }, [key])
  return monacoReady
}

function normalizeLanguageIds(languageIds: readonly string[]): string[] {
  return [...new Set(languageIds.map((languageId) => languageId.trim() || 'plaintext'))].sort()
}

interface EditorModelLifecycle {
  dispose: () => void
  modelUri: () => string
  saveViewState: () => void
}

function trackWorkspaceEditorLifecycle(
  editor: Monaco.editor.IStandaloneCodeEditor,
  preserveViewState: boolean,
): EditorModelLifecycle {
  const modelLifecycle = trackCodeEditorModel(editor, preserveViewState)
  const stopLayoutTracking = trackWorkspaceEditorLayout(editor)
  return {
    ...modelLifecycle,
    dispose: () => {
      stopLayoutTracking()
      modelLifecycle.dispose()
    },
  }
}

type WorkspaceEditorLayoutTarget = Pick<Monaco.editor.IStandaloneCodeEditor, 'layout'>
  | Pick<Monaco.editor.IStandaloneDiffEditor, 'layout'>


/**
 * The box an editor should occupy: the largest one within a few levels above it.
 *
 * Asking Monaco to measure its own container is not enough when the container grows after the
 * editor was first laid out — measured, the editor root held an inline `height: 5px` while the
 * pane above it was 716 px. Climbing a bounded number of levels and taking the largest box
 * finds the surface the user actually sees whether the editor is standalone or inside a diff.
 */
function measureEditorBox(
  hostEditor: Monaco.editor.IStandaloneCodeEditor,
): { width: number; height: number } | null {
  let node: HTMLElement | null = hostEditor.getDomNode()
  let best: { width: number; height: number } | null = null
  for (let depth = 0; node && depth < 4; depth += 1) {
    if (node.clientWidth > 0 && node.clientHeight > 0) {
      best = { width: node.clientWidth, height: node.clientHeight }
    }
    node = node.parentElement
  }
  return best
}

function trackWorkspaceEditorLayout(
  hostEditor: Monaco.editor.IStandaloneCodeEditor,
  layoutTarget: WorkspaceEditorLayoutTarget = hostEditor,
): () => void {
  let frame: number | undefined
  const layoutNow = () => {
    window.cancelAnimationFrame(frame ?? 0)
    frame = undefined
    // Pass a measured size instead of letting Monaco measure its own container. Its root node
    // was observed holding an inline `height: 5px` while the pane around it was a definite
    // 716 px: the editor kept the size it saw when it was first laid out and never took the
    // container's later height. Explicit numbers cannot go stale that way.
    const measured = measureEditorBox(hostEditor)
    if (measured) layoutTarget.layout(measured)
    else layoutTarget.layout()
  }
  const scheduleLayout = (force = false) => {
    if (!force && (
      document.body.classList.contains('is-resizing-column')
      || document.body.classList.contains('is-workspace-navigator-motion')
    )) return
    // Synchronous on purpose. Coalescing onto `requestAnimationFrame` is what Monaco's own
    // `automaticLayout` does, but it makes layout depend on frames arriving, and a window
    // that is occluded, minimized or otherwise not rendering never runs them. Measured in
    // that state: a 715 px pane, a 5 px editor root and exactly one rendered line — blank,
    // and unchanged by calling `layout()` synchronously, because the height chain itself is
    // only resolved when the widget renders. Removing the frame dependency is still the right
    // shape (resize observers already deliver at most one callback per frame, so a frame
    // callback had nothing left to coalesce); it is not a fix for that measurement.
    layoutNow()
  }
  const host = hostEditor.getDomNode()?.parentElement
  const observer = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => scheduleLayout())
  if (host) observer?.observe(host)
  // A frame callback is how layout is coalesced during resizes, but it is the *only* path
  // here, and an occluded, minimized or otherwise non-rendering window never runs animation
  // frames (measured: a 715 px pane with exactly one rendered line). The editor then stays
  // laid out at a stale size until something forces a frame — the surface looks blank.
  // Laying out immediately on mount and whenever the window becomes visible does not depend
  // on a frame arriving; the frame path stays for the resize storms it exists for.
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') layoutNow()
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
  const handleColumnResizeEnd = () => scheduleLayout(true)
  const handleNavigatorMotionStart = () => {
    window.cancelAnimationFrame(frame ?? 0)
    frame = undefined
  }
  const handleNavigatorMotionEnd = () => scheduleLayout(true)
  window.addEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
  window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
  window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
  // Immediate, then the coalesced path for whatever else changes afterwards.
  layoutNow()
  scheduleLayout(true)
  // ...and once more on a task. The container can grow *after* the first measurement without
  // any resize event to announce it — the pane is measured at 716 px while Monaco's root
  // keeps an inline `height: 5px` and renders a single line. A deferred pass costs nothing,
  // needs neither a frame nor an observer, and is what actually corrects that case.
  const deferredLayout = window.setTimeout(() => layoutNow(), 120)
  return () => {
    window.clearTimeout(deferredLayout)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
    window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
    window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
    window.cancelAnimationFrame(frame ?? 0)
  }
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
