// @littlesheep/app — preload/index.ts
// Bridge between main and renderer: exposes the local app API base URL and
// execution readiness via contextBridge. The renderer uses fetch() directly.
//
// The window is shown before the Runtime finishes starting, so this file must
// NOT snapshot the API port at load time: the startup document and the React
// renderer share this preload, and the port only exists once the Local App API
// listener is up. `localApiBase()` resolves then, and the readiness snapshot is
// queryable and subscribable so a missed notification can always be repaired.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  APPLICATION_STATE_FLUSH_ACK_CHANNEL,
  APPLICATION_STATE_FLUSH_CHANNEL,
} from '../shared/application-state-contracts'
import { BROWSER_OPEN_NEW_TAB_CHANNEL, type BrowserOpenNewTabEvent } from '../shared/browser-control-contracts'
import {
  isRendererTimingDuration,
  isRendererTimingStage,
  RENDERER_TIMING_CHANNEL,
  RUNTIME_READINESS_CHANNEL,
  RUNTIME_READINESS_QUERY_CHANNEL,
  RUNTIME_RETRY_EXECUTION_CHANNEL,
  type RendererTimingStage,
} from '../shared/runtime-readiness-ipc'
import {
  isRuntimeReadiness,
  type RuntimeReadiness,
} from '../shared/runtime-readiness-contracts'
import {
  WINDOW_DRAG_END_CHANNEL,
  WINDOW_DRAG_MOVE_CHANNEL,
  WINDOW_DRAG_START_CHANNEL,
  type WindowDragPoint,
} from '../shared/window-drag-contracts'

/**
 * Wait for the Local App API port, bounded so an unavailable Runtime surfaces
 * as an error the renderer can show instead of a request that never settles.
 */
const API_BASE_TIMEOUT_MS = 90_000

let readiness: RuntimeReadiness | undefined
let apiBase: string | undefined
let resolveApiBase: ((base: string) => void) | undefined
const readinessListeners = new Set<(state: RuntimeReadiness) => void>()

function applyReadiness(next: RuntimeReadiness): void {
  readiness = next
  if (apiBase === undefined && typeof next.port === 'number') {
    apiBase = `http://127.0.0.1:${next.port}`
    resolveApiBase?.(apiBase)
    resolveApiBase = undefined
  }
  for (const listener of [...readinessListeners]) {
    try {
      listener(next)
    } catch {
      // A renderer listener must never break the bridge for the others.
    }
  }
}

ipcRenderer.on(RUNTIME_READINESS_CHANNEL, (_event, payload: unknown) => {
  if (!isRuntimeReadiness(payload)) return
  applyReadiness(payload)
})

const apiBasePromise = new Promise<string>((resolve, reject) => {
  resolveApiBase = resolve
  const timer = setTimeout(() => {
    resolveApiBase = undefined
    reject(new Error('Local App API did not report a port within 90 seconds'))
  }, API_BASE_TIMEOUT_MS)
  timer.unref?.()
})
// A window that never asks for the base URL must not produce an unhandled
// rejection when the bounded wait expires; callers still observe the error.
apiBasePromise.catch(() => undefined)

contextBridge.exposeInMainWorld('littlesheep', {
  /** Loopback base URL of the Local App API; resolves once it is listening. */
  localApiBase: () => apiBasePromise,
  /** Current execution readiness, including a stage the renderer may have missed. */
  getRuntimeReadiness: async (): Promise<RuntimeReadiness | undefined> => {
    const queried = await ipcRenderer.invoke(RUNTIME_READINESS_QUERY_CHANNEL).catch(() => undefined)
    if (isRuntimeReadiness(queried)) applyReadiness(queried)
    return readiness
  },
  /** Subscribe to readiness transitions; returns the unsubscribe function. */
  onRuntimeReadiness: (listener: (state: RuntimeReadiness) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!isRuntimeReadiness(payload)) return
      listener(payload)
    }
    ipcRenderer.on(RUNTIME_READINESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(RUNTIME_READINESS_CHANNEL, handler)
  },
  /**
   * Ask Main to run the execution stage again after a failure the user fixed.
   * Main owns the bound and the single-flight rule; this forwards its answer so a
   * refused retry is never presented as a new attempt.
   */
  retryExecution: (): Promise<unknown> => (
    ipcRenderer.invoke(RUNTIME_RETRY_EXECUTION_CHANNEL).catch(() => undefined)
  ),
  /** Report a startup timing mark. Only closed stage names and bounded durations. */
  reportRendererTiming: (stage: RendererTimingStage, durationMs: number) => {
    if (!isRendererTimingStage(stage)) return
    if (!isRendererTimingDuration(durationMs)) return
    ipcRenderer.send(RENDERER_TIMING_CHANNEL, stage, durationMs)
  },
  getPathForFile: (file: unknown) => {
    try {
      return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
    } catch {
      return ''
    }
  },
  onBrowserOpenNewTab: (listener: (event: BrowserOpenNewTabEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as Partial<BrowserOpenNewTabEvent>
      if (typeof value.url !== 'string' || !/^https?:\/\//iu.test(value.url)) return
      listener({ url: value.url, disposition: typeof value.disposition === 'string' ? value.disposition : undefined })
    }
    ipcRenderer.on(BROWSER_OPEN_NEW_TAB_CHANNEL, handler)
    return () => ipcRenderer.removeListener(BROWSER_OPEN_NEW_TAB_CHANNEL, handler)
  },
  onApplicationStateFlush: (listener: () => void) => {
    const handler = (_event: Electron.IpcRendererEvent, requestId: unknown) => {
      if (typeof requestId !== 'string' || requestId.length > 128) return
      try {
        listener()
      } finally {
        ipcRenderer.send(APPLICATION_STATE_FLUSH_ACK_CHANNEL, requestId)
      }
    }
    ipcRenderer.on(APPLICATION_STATE_FLUSH_CHANNEL, handler)
    return () => ipcRenderer.removeListener(APPLICATION_STATE_FLUSH_CHANNEL, handler)
  },
  startWindowDrag: (point: WindowDragPoint) => ipcRenderer.send(WINDOW_DRAG_START_CHANNEL, point),
  moveWindowDrag: (point: WindowDragPoint) => ipcRenderer.send(WINDOW_DRAG_MOVE_CHANNEL, point),
  endWindowDrag: () => ipcRenderer.send(WINDOW_DRAG_END_CHANNEL),
})
