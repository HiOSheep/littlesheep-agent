// Owns conversation-scoped workspace layout buckets, draft adoption, persistence, and mirror recovery.
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { APPLICATION_PERSISTENCE_FLUSH_EVENT } from '../../shared/application-state-contracts'
import {
  readWorkspaceLayoutSnapshot,
  saveWorkspaceLayoutSnapshot,
  type RuntimeState,
} from '../api'
import { clampNumber } from '../app-shell/navigation'
import {
  readLegacyWorkspaceSessionLayout,
  readWorkspaceLayoutFallbackMarkers,
  readWorkspaceSessionLayoutsPreference,
  shouldApplyWorkspaceLayoutFallback,
  writeWorkspaceSessionLayoutsPreference,
} from '../app-shell/preferences'
import {
  RESPONSIVE_LAYOUT_PREFERENCE_MAX,
  RESPONSIVE_LAYOUT_PREFERENCE_MIN,
  WORKSPACE_PANEL_WIDTH_DEFAULT,
  WORKSPACE_PANEL_WIDTH_MAX,
} from '../workspace-layout'
import {
  WORKSPACE_PANEL_OPEN_TABS_MAX,
  alignWorkspacePanelStateToRoot,
  createDefaultWorkspaceSessionLayout,
  dedupeWorkspacePanelTabs,
  hydrateWorkspaceLayoutFallbackSnapshot,
  normalizeWorkspaceSessionLayout,
  rebindWorkspacePanelState,
  rebindWorkspacePath,
  serializeWorkspaceFileDrafts,
  workspaceSessionKey,
  workspaceSessionLayoutFromSnapshot,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTabId,
  type WorkspaceSessionLayout,
  type WorkspaceSessionLayouts,
} from '../workspace-persistence'
import { readWorkspaceBrowserTabsPreference } from './browser-persistence'
import { adoptWorkspaceDraftSessionLayout } from './layout-ownership'
import type { WorkspaceBrowserTab } from './browser-tabs'
import { isPathInsideOrSameClient } from './path-utils'

export interface ClosingWorkspaceFileState {
  layoutKey: string
  sessionId?: string
  fileTabId: WorkspaceFileTabId
  hasSavedVersion: boolean
  savedText: string
  modifiedAt?: number
}

interface WorkspaceSessionLayoutOptions {
  runtime: RuntimeState | null
  currentSession: string | undefined
  defaultWorkspacePath: string
  workspacePanelWidthPreference: number
  setWorkspacePanelWidthPreference: Dispatch<SetStateAction<number>>
  setWorkspacePanelReopenActive: Dispatch<SetStateAction<boolean>>
}



export function useWorkspaceSessionLayouts({
  runtime,
  currentSession,
  defaultWorkspacePath,
  workspacePanelWidthPreference,
  setWorkspacePanelWidthPreference,
  setWorkspacePanelReopenActive,
}: WorkspaceSessionLayoutOptions) {
  const initialLayouts = useMemo(readInitialWorkspaceSessionLayouts, [])
  const activeWorkspaceSessionKey = workspaceSessionKey(currentSession)
  const [layouts, setLayouts] = useState<WorkspaceSessionLayouts>(initialLayouts)
  const activeLayout = useMemo(
    () => layouts[activeWorkspaceSessionKey] ?? createDefaultWorkspaceSessionLayout(),
    [activeWorkspaceSessionKey, layouts],
  )
  const layoutsRef = useRef(layouts)
  const activeKeyRef = useRef(activeWorkspaceSessionKey)
  const touchedKeysRef = useRef(new Set<string>())
  const loadedKeysRef = useRef(new Set<string>())
  const previousKeyRef = useRef(activeWorkspaceSessionKey)
  const closingFileTabsRef = useRef(new Map<string, ClosingWorkspaceFileState>())
  const [readyKey, setReadyKey] = useState<string | null>(null)
  layoutsRef.current = layouts
  activeKeyRef.current = activeWorkspaceSessionKey

  useEffect(() => {
    const timer = window.setTimeout(() => writeWorkspaceSessionLayoutsPreference(layouts), 250)
    return () => window.clearTimeout(timer)
  }, [layouts])

  useEffect(() => {
    const flush = () => writeWorkspaceSessionLayoutsPreference(layoutsRef.current)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    window.addEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener(APPLICATION_PERSISTENCE_FLUSH_EVENT, flush)
    }
  }, [])

  useEffect(() => {
    if (activeLayout.openTabs.length === 0) return
    setWorkspacePanelOpenTabs((tabs) => (
      tabs.includes(activeLayout.activeTab)
        ? tabs
        : dedupeWorkspacePanelTabs(
          tabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX
            ? [...tabs.slice(1), activeLayout.activeTab]
            : [...tabs, activeLayout.activeTab],
        )
    ))
  }, [activeLayout.activeTab])

  useLayoutEffect(() => {
    const previousKey = previousKeyRef.current
    previousKeyRef.current = activeWorkspaceSessionKey
    if (previousKey === activeWorkspaceSessionKey) return
    setWorkspacePanelReopenActive(false)

    if (previousKey !== workspaceSessionKey(undefined) || !currentSession) return
    const currentLayouts = layoutsRef.current
    const nextLayouts = adoptWorkspaceDraftSessionLayout(currentLayouts, currentSession)
    if (nextLayouts === currentLayouts) return
    layoutsRef.current = nextLayouts
    loadedKeysRef.current.add(activeWorkspaceSessionKey)
    for (const closingState of closingFileTabsRef.current.values()) {
      if (closingState.layoutKey !== previousKey) continue
      closingState.layoutKey = activeWorkspaceSessionKey
      closingState.sessionId = currentSession
    }
    setLayouts(nextLayouts)
  }, [activeWorkspaceSessionKey, currentSession, setWorkspacePanelReopenActive])

  useEffect(() => {
    if (!runtime) return
    const key = activeWorkspaceSessionKey
    if (loadedKeysRef.current.has(key)) {
      setReadyKey(key)
      return
    }
    if (layoutsRef.current[key]) {
      loadedKeysRef.current.add(key)
      setReadyKey(key)
      return
    }

    setReadyKey(null)
    let disposed = false
    async function recoverFromMirror() {
      try {
        const fallback = hydrateWorkspaceLayoutFallbackSnapshot(
          await readWorkspaceLayoutSnapshot(currentSession),
        )
        if (disposed) return
        const sessionMatches = !fallback?.sessionId
          ? !currentSession
          : fallback.sessionId === currentSession
        if (
          fallback &&
          sessionMatches &&
          shouldApplyWorkspaceLayoutFallback(
            fallback.workspacePath,
            defaultWorkspacePath,
            fallback.openRequest,
          ) &&
          !touchedKeysRef.current.has(key) &&
          !layoutsRef.current[key]
        ) {
          commitLayout(
            key,
            alignWorkspaceSessionLayoutToRoot(
              workspaceSessionLayoutFromSnapshot(fallback),
              defaultWorkspacePath,
            ),
            false,
          )
          const widthMarker = readWorkspaceLayoutFallbackMarkers().width
          if (!(typeof widthMarker === 'string' && Number.isFinite(Number(widthMarker)))) {
            setWorkspacePanelWidthPreference(clampNumber(
              fallback.width ?? WORKSPACE_PANEL_WIDTH_DEFAULT,
              RESPONSIVE_LAYOUT_PREFERENCE_MIN,
              Math.max(RESPONSIVE_LAYOUT_PREFERENCE_MAX, WORKSPACE_PANEL_WIDTH_MAX),
            ))
          }
        } else if (!layoutsRef.current[key]) {
          commitLayout(
            key,
            alignWorkspaceSessionLayoutToRoot(
              createDefaultWorkspaceSessionLayout(),
              defaultWorkspacePath,
            ),
            false,
          )
        }
      } catch {
        if (!layoutsRef.current[key]) {
          commitLayout(key, createDefaultWorkspaceSessionLayout(), false)
        }
      } finally {
        if (!disposed) {
          loadedKeysRef.current.add(key)
          setReadyKey(key)
        }
      }
    }
    void recoverFromMirror()
    return () => {
      disposed = true
    }
  }, [activeWorkspaceSessionKey, currentSession, defaultWorkspacePath, runtime, setWorkspacePanelWidthPreference])

  const workspacePanelRoot = activeLayout.openRequest?.root ?? defaultWorkspacePath
  useEffect(() => {
    if (readyKey !== activeWorkspaceSessionKey || !workspacePanelRoot) return
    const timer = window.setTimeout(() => {
      const openRequest = activeLayout.openRequest
        ? { root: activeLayout.openRequest.root, path: activeLayout.openRequest.path }
        : null
      void saveWorkspaceLayoutSnapshot({
        workspacePath: workspacePanelRoot,
        sessionId: currentSession,
        // Width mirrors use the same 1280px reference basis as the renderer
        // preference so recovery does not depend on the previous window size.
        width: workspacePanelWidthPreference,
        collapsed: activeLayout.collapsed,
        fullscreen: activeLayout.fullscreen,
        activeTab: activeLayout.activeTab,
        openTabs: activeLayout.openTabs,
        openRequest,
        fileNavigatorCollapsed: activeLayout.fileNavigatorCollapsed,
        fileNavigatorWidth: activeLayout.fileNavigatorWidth,
        expandedPaths: activeLayout.expandedPaths,
        drafts: serializeWorkspaceFileDrafts(activeLayout.drafts, activeLayout.openTabs),
        browserTabs: activeLayout.browserTabs,
      }).catch(() => undefined)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    activeLayout,
    activeWorkspaceSessionKey,
    currentSession,
    readyKey,
    workspacePanelRoot,
    workspacePanelWidthPreference,
  ])

  function commitLayout(key: string, layout: WorkspaceSessionLayout, markTouched = true) {
    const nextLayouts = { ...layoutsRef.current, [key]: layout }
    layoutsRef.current = nextLayouts
    if (markTouched) touchedKeysRef.current.add(key)
    setLayouts(nextLayouts)
  }

  function updateLayout(key: string, update: (layout: WorkspaceSessionLayout) => WorkspaceSessionLayout) {
    const current = layoutsRef.current[key] ?? createDefaultWorkspaceSessionLayout()
    commitLayout(key, update(current))
  }

  function updateActiveLayout(update: (layout: WorkspaceSessionLayout) => WorkspaceSessionLayout) {
    updateLayout(activeWorkspaceSessionKey, update)
  }

  function setField<K extends keyof WorkspaceSessionLayout>(
    field: K,
    update: SetStateAction<WorkspaceSessionLayout[K]>,
  ) {
    updateActiveLayout((layout) => ({
      ...layout,
      [field]: resolveStateAction(update, layout[field]),
    }))
  }

  const setWorkspacePanelCollapsed = (update: SetStateAction<boolean>) => setField('collapsed', update)
  const setWorkspacePanelFullscreen = (update: SetStateAction<boolean>) => setField('fullscreen', update)
  const setWorkspacePanelTab = (update: SetStateAction<WorkspacePanelTabId>) => setField('activeTab', update)
  const setWorkspacePanelOpenTabs = (update: SetStateAction<WorkspacePanelTabId[]>) => setField('openTabs', update)
  const setWorkspaceOpenRequest = (update: SetStateAction<WorkspaceOpenRequest | null>) => setField('openRequest', update)
  const setWorkspaceFileNavigatorCollapsed = (update: SetStateAction<boolean>) => setField('fileNavigatorCollapsed', update)
  const setWorkspaceFileNavigatorWidth = (update: SetStateAction<number>) => setField('fileNavigatorWidth', update)
  const setWorkspaceExpandedPaths = (update: SetStateAction<string[]>) => setField('expandedPaths', update)
  const setWorkspaceBrowserTabs = (update: SetStateAction<WorkspaceBrowserTab[]>) => setField('browserTabs', update)

  function setWorkspaceSessionFileDrafts(
    key: string,
    update: SetStateAction<Record<string, WorkspaceFileDraftState>>,
  ) {
    updateLayout(key, (layout) => ({
      ...layout,
      drafts: resolveStateAction(update, layout.drafts),
    }))
  }

  function setWorkspaceFileDrafts(update: SetStateAction<Record<string, WorkspaceFileDraftState>>) {
    setWorkspaceSessionFileDrafts(activeWorkspaceSessionKey, update)
  }

  function resetWorkspaceSessionLayout(sessionId?: string) {
    const key = workspaceSessionKey(sessionId)
    commitLayout(key, createDefaultWorkspaceSessionLayout())
    loadedKeysRef.current.add(key)
    if (key === activeWorkspaceSessionKey) setReadyKey(key)
  }

  function removeWorkspaceSessionLayout(sessionId: string) {
    const key = workspaceSessionKey(sessionId)
    if (!layoutsRef.current[key]) return
    const nextLayouts = { ...layoutsRef.current }
    delete nextLayouts[key]
    layoutsRef.current = nextLayouts
    touchedKeysRef.current.delete(key)
    loadedKeysRef.current.delete(key)
    setLayouts(nextLayouts)
  }

  function alignWorkspaceSessionToRoot(
    root: string,
    sessionId: string | null | undefined = currentSession,
  ) {
    const normalizedRoot = root.trim()
    if (!normalizedRoot) return
    const key = workspaceSessionKey(sessionId ?? undefined)
    const layout = layoutsRef.current[key]
    if (layout) commitLayout(key, alignWorkspaceSessionLayoutToRoot(layout, normalizedRoot))
  }

  function rebindWorkspaceSessionLayouts(fromRoot: string, toRoot: string) {
    const nextLayouts: WorkspaceSessionLayouts = {}
    for (const [key, layout] of Object.entries(layoutsRef.current)) {
      const rebound = rebindWorkspacePanelState({
        openRequest: layout.openRequest,
        openTabs: layout.openTabs,
        activeTab: layout.activeTab,
        drafts: layout.drafts,
      }, fromRoot, toRoot)
      nextLayouts[key] = {
        ...layout,
        ...rebound,
        expandedPaths: layout.expandedPaths.map((path) => rebindWorkspacePath(path, fromRoot, toRoot)),
      }
      touchedKeysRef.current.add(key)
    }
    layoutsRef.current = nextLayouts
    setLayouts(nextLayouts)
  }

  return {
    activeWorkspaceSessionKey,
    activeWorkspaceSessionKeyRef: activeKeyRef,
    workspaceSessionLayoutsRef: layoutsRef,
    closingWorkspaceFileTabsRef: closingFileTabsRef,
    workspacePanelRoot,
    workspacePanelCollapsed: activeLayout.collapsed,
    workspacePanelFullscreen: activeLayout.fullscreen,
    workspacePanelTab: activeLayout.activeTab,
    workspacePanelOpenTabs: activeLayout.openTabs,
    workspaceOpenRequest: activeLayout.openRequest,
    workspaceFileDrafts: activeLayout.drafts,
    workspaceFileNavigatorCollapsed: activeLayout.fileNavigatorCollapsed,
    workspaceFileNavigatorWidth: activeLayout.fileNavigatorWidth,
    workspaceExpandedPaths: activeLayout.expandedPaths,
    workspaceBrowserTabs: activeLayout.browserTabs,
    setWorkspacePanelCollapsed,
    setWorkspacePanelFullscreen,
    setWorkspacePanelTab,
    setWorkspacePanelOpenTabs,
    setWorkspaceOpenRequest,
    setWorkspaceFileDrafts,
    setWorkspaceSessionFileDrafts,
    setWorkspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorWidth,
    setWorkspaceExpandedPaths,
    setWorkspaceBrowserTabs,
    commitWorkspaceSessionLayout: commitLayout,
    resetWorkspaceSessionLayout,
    removeWorkspaceSessionLayout,
    alignWorkspaceSessionToRoot,
    rebindWorkspaceSessionLayouts,
  }
}

function readInitialWorkspaceSessionLayouts(): WorkspaceSessionLayouts {
  const stored = readWorkspaceSessionLayoutsPreference()
  if (Object.keys(stored).length > 0) return stored
  const legacy = readLegacyWorkspaceSessionLayout()
  const browserTabs = readWorkspaceBrowserTabsPreference()
  if (!legacy && browserTabs.length === 0) return {}
  return {
    [workspaceSessionKey(undefined)]: normalizeWorkspaceSessionLayout({
      ...(legacy ?? createDefaultWorkspaceSessionLayout()),
      browserTabs,
    }),
  }
}

function alignWorkspaceSessionLayoutToRoot(
  layout: WorkspaceSessionLayout,
  root: string,
): WorkspaceSessionLayout {
  const aligned = alignWorkspacePanelStateToRoot({
    openRequest: layout.openRequest,
    openTabs: layout.openTabs,
    activeTab: layout.activeTab,
    drafts: layout.drafts,
  }, root)
  return {
    ...layout,
    ...aligned,
    expandedPaths: layout.expandedPaths.filter((path) => isPathInsideOrSameClient(path, root)),
  }
}

function resolveStateAction<T>(update: SetStateAction<T>, current: T): T {
  return typeof update === 'function'
    ? (update as (value: T) => T)(current)
    : update
}
